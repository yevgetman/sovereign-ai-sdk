// Phase 17 T7 — production wiring of CronRunner against the live Runtime.
//
// `createProductionCronRunner(runtime, harnessHome)` builds a CronRunner whose
// `runJob` callback dispatches a fresh-session AgentRunner for each due cron
// job. The three pluggable dependencies expected by `buildCronJobExecutor`
// (runAgent / expandSkills / runScript) are wired here:
//
//   - runAgent: mints a child session row (metadata.kind='cron'), constructs
//     an AgentRunner over a cron-filtered tool pool and a default-mode
//     canUseTool whose `ask` callback auto-denies (matches `sov drive`
//     headless policy — cron jobs never reach an interactive surface), drains
//     the generator, and returns the final assistant text. The session is
//     disposed in a finally block so trace writers and learning observers
//     flush even on agent error.
//   - expandSkills: walks `job.skills`, looks each up in `runtime.skills.byName`,
//     expands the body via `expandSkillPrompt`, and joins on `\n\n---\n\n`.
//     Throws on unknown skill name (caught by the executor's try/catch).
//   - runScript: spawns the resolved interpreter under `cwd` with a timeout,
//     throws on non-zero exit, returns stdout capped at MAX_SCRIPT_STDOUT.
//
// Path resolution: absolute script paths pass through; relative paths resolve
// under `<harnessHome>/cron/scripts/`. Interpreter inference is suffix-based
// (.py/.ts/.js/.sh) with direct exec as the fallback.

import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { SUBAGENT_EXCLUDED_TOOLS } from '../agents/exclusions.js';
import { loadPermissionSettings } from '../config/settings.js';
import type { AssistantMessage } from '../core/types.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import type { AskResponse } from '../permissions/types.js';
import type { LLMProvider } from '../providers/types.js';
import { AgentRunner } from '../runtime/agentRunner.js';
import { buildSessionToolContext } from '../server/routes/turns.js';
import type { Runtime } from '../server/runtime.js';
import { buildCronJobExecutor } from './execute.js';
import { type CronRunResult, CronRunner } from './runner.js';
import type { Job } from './types.js';

/** Hard cap on captured script stdout. Larger captures truncate at this
 *  boundary before being interpolated into the user prompt (T6 sketch). */
const MAX_SCRIPT_STDOUT = 16 * 1024;

/** Default cap on per-cron-job agent iterations. Matches the AgentRunner
 *  built-in default but is set explicitly so a future config knob has a
 *  single place to thread through. */
const DEFAULT_CRON_MAX_TURNS = 10;

/** Resolve a job's `script` field to an absolute filesystem path. Absolute
 *  paths pass through; relative paths anchor to `<harnessHome>/cron/scripts/`
 *  so users have a canonical bucket without sacrificing the escape hatch of
 *  pointing at an arbitrary tree. */
export function resolveScriptPath(harnessHome: string, scriptPath: string): string {
  return isAbsolute(scriptPath)
    ? scriptPath
    : resolve(join(harnessHome, 'cron', 'scripts', scriptPath));
}

/** Suffix-based interpreter inference. Returns the argv tuple to feed into
 *  `spawnSync`: `[interpreter, scriptPath]` for known suffixes, or just
 *  `[scriptPath]` (direct exec) for everything else. */
export function inferInterpreter(scriptPath: string): readonly [string, ...string[]] {
  if (scriptPath.endsWith('.py')) return ['python3', scriptPath];
  if (scriptPath.endsWith('.ts') || scriptPath.endsWith('.js')) return ['bun', scriptPath];
  if (scriptPath.endsWith('.sh')) return ['bash', scriptPath];
  return [scriptPath];
}

/** Extract the final assistant text from an AgentRunner result. Mirrors the
 *  `extractSummary` helper in src/runtime/scheduler.ts so cron's contract
 *  with the model matches what sub-agents already produce: join all text
 *  blocks from the last assistant message, trim. Tool-use and thinking
 *  blocks are dropped — the channel's recipient sees only the user-facing
 *  text. */
function extractFinalText(assistant: AssistantMessage | undefined): string {
  if (!assistant) return '';
  return assistant.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Build a production CronRunner bound to the live Runtime. Caller owns the
 *  lifecycle: `runner.start()` arms the 60s tick interval, `runner.stop()`
 *  clears it. buildRuntime invokes both inside its own lifecycle (T7 step
 *  3); other callers shouldn't need this entry point directly. */
export function createProductionCronRunner(runtime: Runtime, harnessHome: string): CronRunner {
  const executor = buildCronJobExecutor({
    harnessHome,
    cwd: runtime.cwd,
    runAgent: async ({ prompt, cronJobId }) => {
      // Each cron run gets a fresh session so the model has no carry-over
      // context from prior runs (matches the spec's "Hermes-style
      // short-lived fire-and-forget" framing). The session row is tagged
      // `metadata.kind='cron'` so later cleanup sweeps can scope by tag
      // without scanning every row.
      const sessionId = runtime.sessionDb.createSession({
        provider: runtime.resolvedProvider.transport.name,
        model: runtime.model,
        title: `cron:${cronJobId}`,
        systemPrompt: runtime.systemSegments,
        metadata: { kind: 'cron', cronJobId },
      });

      try {
        // Cron is non-interactive. Default mode honors explicit allow/deny
        // rules in layered settings; any fall-through to `ask` auto-denies
        // (matches `sov drive` headless policy). Tool self-checks that
        // return 'allow' still pass; this only catches the `ask` branch.
        const permissionSettings = loadPermissionSettings({
          cwd: runtime.cwd,
          harnessHome: runtime.harnessHome,
        });
        const ask = async (): Promise<AskResponse> => 'deny';
        const canUseTool = buildCanUseTool({
          mode: 'default',
          ask,
          alwaysAllow: new Set<string>(),
          ruleLayers: permissionSettings.layers,
        });

        // Filter the parent tool pool against the subagent exclusion set —
        // which already lists the cron CRUD verbs (cron_add / cron_list /
        // cron_show / cron_pause / cron_resume / cron_delete) plus
        // AgentTool, task_stop, send_message. A cron job is a kind of
        // non-interactive child, so this is the right ceiling.
        const cronToolPool = runtime.toolPool.filter(
          (tool) => !SUBAGENT_EXCLUDED_TOOLS.has(tool.name),
        );

        // Reuse the canonical session-scoped ToolContext builder. It wires
        // the per-session subsystems (learning observer, review manager,
        // memory manager, project scope) the same way the turns route does
        // so a cron-spawned agent sees the same world as an interactive
        // turn — minus the SSE bus + serverAsk (cron auto-denies any
        // fall-through ask, so no bus is needed). It also builds (and caches)
        // the SessionContext we read memoryManager + recall off of below.
        const toolContext = buildSessionToolContext(runtime, sessionId, canUseTool);
        // Learning-loop participation — the SAME per-session context the
        // ToolContext above was built from (getSessionContext caches by
        // sessionId). It carries the memory manager (always present) and the
        // recall thunk (present only when recall is enabled), which we thread
        // into the AgentRunner so a scheduled job draws on MEMORY.md + learned
        // instincts and writes memory back — exactly like the interactive turns
        // route and the channel pipeline. Cron sessions are owner-null →
        // legacy/global memory + learning namespace (correct for operator-
        // scheduled jobs). Without this, a cron job never injected MEMORY.md,
        // never ran recall, and never wrote memory back (the same omission the
        // Phase-F channel fix closed for channels).
        const sessionCtx = runtime.getSessionContext(sessionId);

        const runner = new AgentRunner({
          provider: runtime.resolvedProvider.transport as unknown as LLMProvider,
          model: runtime.model,
          systemPrompt: runtime.systemSegments,
          maxTokens: runtime.maxTokens,
          tools: cronToolPool,
          toolContext,
          canUseTool,
          maxTurns: DEFAULT_CRON_MAX_TURNS,
          sessionId,
          cwd: runtime.cwd,
          // Thread memory + recall (mirrors the turns route + channel pipeline).
          // memoryManager is always present; recall is conditionally spread so a
          // recall-disabled session stays inert (matches the
          // `...(recall ? { recall } : {})` discipline elsewhere).
          memoryManager: sessionCtx.memoryManager,
          ...(sessionCtx.recall !== undefined ? { recall: sessionCtx.recall } : {}),
        });

        const gen = runner.run(prompt);
        let final: Awaited<ReturnType<typeof gen.next>>;
        for (;;) {
          final = await gen.next();
          if (final.done) break;
          // StreamEvents and per-turn Messages are drained but not
          // surfaced — cron has no UI consumer. The terminal value is
          // what matters.
        }
        const result = final.value;
        const output = extractFinalText(result.finalAssistant);

        if (result.terminal.reason === 'completed') {
          return { ok: true, output };
        }
        const errMsg =
          result.terminal.error instanceof Error
            ? result.terminal.error.message
            : (result.terminal.reason ?? 'unknown');
        return {
          ok: false,
          output,
          error: `terminal=${result.terminal.reason}: ${errMsg}`,
        };
      } finally {
        // Always tear down per-session subsystems (trace writer flush,
        // trajectory write, review manager dispose) — even on agent
        // error. The session row itself stays in the DB for later
        // inspection.
        await runtime.disposeSession(sessionId);
      }
    },
    expandSkills: async (skills, _cwd) => {
      // Skills compose into a single user-message body, separated by the
      // canonical `---` horizontal-rule fence the rest of the harness
      // uses (matches expandSkillPrompt's own composition style). Unknown
      // skill name throws; the executor's outer try/catch surfaces it as
      // a job-level failure with a clear error string.
      // The `_cwd` arg is the executor's resolved cwd, but skills source
      // their dir from the registry entry — we pass through the runtime
      // cwd via the SkillExpansionOptions below for consistency with the
      // turn-time expansion path.
      const { expandSkillPrompt } = await import('../skills/loader.js');
      const expansions: string[] = [];
      for (const name of skills) {
        const skill = runtime.skills.byName.get(name);
        if (!skill) {
          throw new Error(`unknown skill: ${name}`);
        }
        const expanded = await expandSkillPrompt(skill, {
          args: '',
          cwd: runtime.cwd,
          sessionId: 'cron',
        });
        expansions.push(expanded);
      }
      return expansions.join('\n\n---\n\n');
    },
    runScript: async (scriptPath, cwd, timeoutMs) => {
      const resolved = resolveScriptPath(harnessHome, scriptPath);
      const argv = inferInterpreter(resolved);
      // `argv[0]` is statically known to be a string by inferInterpreter's
      // return type, but spawnSync requires (command, args[]) so destructure
      // for type clarity (noUncheckedIndexedAccess in tsconfig would warn
      // on `argv[0]` otherwise).
      const [cmd, ...args] = argv;
      const result = spawnSync(cmd, args, {
        cwd,
        timeout: timeoutMs,
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const stderr = (result.stderr ?? '').slice(0, 1024);
        throw new Error(`script exited ${result.status}: ${stderr}`);
      }
      return (result.stdout ?? '').slice(0, MAX_SCRIPT_STDOUT);
    },
  });

  return new CronRunner({
    harnessHome,
    now: () => Date.now(),
    runJob: (job: Job): Promise<CronRunResult> => executor(job),
  });
}
