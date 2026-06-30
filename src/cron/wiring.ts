// Phase 17 T7 — production wiring of CronRunner against the live Runtime.
//
// `createProductionCronRunner(runtime, harnessHome)` builds a CronRunner whose
// `runJob` callback dispatches a fresh-session AgentRunner for each due cron
// job. The three pluggable dependencies expected by `buildCronJobExecutor`
// (runAgent / expandSkills / runScript) are wired here:
//
//   - runAgent: mints a child session row (metadata.kind='cron'), drives one
//     turn via the open SDK's `createAgent().run()` (Task 4.2 re-seat, was
//     `AgentRunner`) over a cron-filtered tool pool and a default-mode
//     canUseTool whose `ask` callback auto-denies (matches `sov drive`
//     headless policy — cron jobs never reach an interactive surface), drains
//     the generator, and returns the final assistant text. The re-seat also
//     lands the ratified microcompaction + transcript parity-fixes (see
//     `buildCronAgentConfig`). The session is disposed in a finally block so
//     trace writers and learning observers flush even on agent error.
//   - expandSkills: walks `job.skills`, looks each up in `runtime.skills.byName`,
//     expands the body via `expandSkillPrompt`, and joins on `\n\n---\n\n`.
//     Throws on unknown skill name (caught by the executor's try/catch).
//   - runScript: spawns the resolved interpreter under `cwd` with a timeout,
//     throws on non-zero exit, returns stdout capped at MAX_SCRIPT_STDOUT.
//     Uses async `spawn` (NOT `spawnSync`) so a slow script never blocks the
//     long-lived gateway/serve/TUI event loop the cron tick runs inside.
//
// Path resolution: absolute script paths pass through; relative paths resolve
// under `<harnessHome>/cron/scripts/`. Interpreter inference is suffix-based
// (.py/.ts/.js/.sh) with direct exec as the fallback.

import { isAbsolute, join, resolve } from 'node:path';
import { type AgentConfig, createAgent } from '../agent/createAgent.js';
import { SUBAGENT_EXCLUDED_TOOLS } from '../agents/exclusions.js';
import type { MicrocompactConfig } from '../compact/microcompact.js';
import { loadPermissionSettings } from '../config/settings.js';
import type { AssistantMessage, RecallTurn, SystemSegment } from '../core/types.js';
import type { MemoryRuntime } from '../memory/provider.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import type { AskResponse } from '../permissions/types.js';
import type { TranscriptStore } from '../persistence/transcriptStore.js';
import type { ReasoningEffort } from '../providers/effort.js';
import type { LLMProvider } from '../providers/types.js';
import { buildSessionToolContext } from '../server/routes/turns.js';
import type { Runtime } from '../server/runtime.js';
import type { Tool } from '../tool/types.js';
import { buildCronJobExecutor } from './execute.js';
import { type CronRunResult, CronRunner } from './runner.js';
import type { Job } from './types.js';

/** Hard cap on captured script stdout. Larger captures truncate at this
 *  boundary before being interpolated into the user prompt (T6 sketch). */
const MAX_SCRIPT_STDOUT = 16 * 1024;

/** Cap on the stderr fragment surfaced in a non-zero-exit error message
 *  (matches the prior `spawnSync` path's `.slice(0, 1024)`). */
const SCRIPT_STDERR_CAP = 1024;

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

/** Run a pre-agent cron script asynchronously and return its captured
 *  stdout (truncated at MAX_SCRIPT_STDOUT). Replaces the previous
 *  `spawnSync` so a slow script can't block the event loop of a long-lived
 *  gateway/serve/TUI process the cron tick runs inside.
 *
 *  Contract (identical to the prior `spawnSync` path):
 *   - resolves `scriptPath` under `<harnessHome>/cron/scripts/` (relative)
 *     or passes an absolute path through;
 *   - infers the interpreter by suffix (.py/.ts/.js/.sh), else direct exec;
 *   - throws on a non-zero exit, surfacing the status + capped stderr;
 *   - throws on a spawn error (e.g. interpreter not found);
 *   - returns stdout capped at MAX_SCRIPT_STDOUT.
 *
 *  Hardening beyond the old path:
 *   - stdout is TRUNCATED at the cap as it streams (the process keeps
 *     running, its later output is dropped) rather than letting a buffer
 *     grow unbounded or throwing ENOBUFS the way `spawnSync({ maxBuffer })`
 *     would;
 *   - on timeout the child is HARD-killed with SIGKILL so a script that
 *     traps SIGTERM can't hang the tick, and the call rejects with a
 *     "timed out" error. */
export async function runCronScript(
  harnessHome: string,
  scriptPath: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const resolved = resolveScriptPath(harnessHome, scriptPath);
  const argv = inferInterpreter(resolved);

  // Use Bun.spawn — the same primitive BashTool and the skill-interpolation
  // path use. It is native (not `node:child_process`), so it is immune to a
  // sibling test's process-global `mock.module('node:child_process', …)`
  // leak, and it matches the codebase's spawn convention. Output is read off
  // the streams and capped; the timeout is a race so a SIGTERM-trapping script
  // (or a grandchild holding the stdout pipe) can never hang the cron tick.
  const proc = Bun.spawn([...argv], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), timeoutMs);
    timer.unref?.();
  });

  const work = (async () => {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamCapped(proc.stdout, MAX_SCRIPT_STDOUT),
      readStreamCapped(proc.stderr, SCRIPT_STDERR_CAP),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  })();

  try {
    const outcome = await Promise.race([work, timeout]);
    if (outcome === 'timeout') {
      // Hard-kill and reject immediately — do NOT await `work` (a
      // SIGTERM-trapping script or a grandchild holding the pipe could keep it
      // pending; the orphaned grandchild exits on its own). SIGKILL is untrappable.
      proc.kill('SIGKILL');
      throw new Error(`script timed out after ${timeoutMs}ms`);
    }
    if (outcome.exitCode !== 0) {
      throw new Error(
        `script exited ${outcome.exitCode}: ${outcome.stderr.slice(0, SCRIPT_STDERR_CAP)}`,
      );
    }
    return outcome.stdout;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read a Bun subprocess stream to text, retaining at most `cap` bytes. Once
 *  the cap is hit we KEEP draining the stream (discarding the rest) rather than
 *  cancelling the reader: cancelling closes the read end mid-write, so a script
 *  still printing gets SIGPIPE and exits non-zero. Draining lets it finish
 *  cleanly while bounding memory (the spawnSync analogue would ENOBUFS). */
async function readStreamCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (truncated || !value) continue; // keep draining, but stop appending
    out += decoder.decode(value, { stream: true });
    if (out.length >= cap) {
      out = out.slice(0, cap);
      truncated = true;
    }
  }
  if (!truncated) out += decoder.decode();
  return out;
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

/** The standing inputs one cron turn assembles its `createAgent` config from.
 *  Every field maps 1:1 from the prior `AgentRunner` opts the cron path passed,
 *  PLUS the two CEO-ratified parity-fixes (`microcompactConfig` + `transcripts`)
 *  that the AgentRunner surface structurally could not carry. Kept as an
 *  explicit primitive bag (not the live `Runtime`) so the field-level parity is
 *  unit-testable in isolation, with no runtime spin-up. The per-turn slice
 *  (sessionId / toolContext / canUseTool) is applied at `run()`, not here. */
export type CronAgentConfigInput = {
  provider: LLMProvider;
  model: string;
  effort: ReasoningEffort;
  systemPrompt: SystemSegment[];
  maxTokens: number;
  cwd: string;
  tools: Tool<unknown, unknown>[];
  memoryManager: MemoryRuntime;
  recall?: RecallTurn;
  /** Parity-fix #1 — the runtime's settings-derived microcompaction config.
   *  `AgentRunner` had no such field, so the cron path previously ran on
   *  `query()`'s built-in `DEFAULT_MICROCOMPACT_CONFIG` regardless of the
   *  operator's `microcompaction.*` settings; the turns route already threads
   *  this exact value, and now so does cron. */
  microcompactConfig: MicrocompactConfig;
  /** Parity-fix #2 — the runtime's per-session transcript store, when present,
   *  so a scheduled turn is transcribed like an interactive one. The old
   *  AgentRunner path never persisted and cron never called `persistMessage`,
   *  so a cron turn was never transcribed; passing the store closes that gap. */
  transcripts?: TranscriptStore;
};

/** Assemble the standing `AgentConfig` for one cron turn. Pure (no I/O) so the
 *  1:1 mapping from the prior `AgentRunner` opts — and the two ratified
 *  additions — is verifiable without a runtime. Optional fields (`recall`,
 *  `transcripts`) are conditionally spread so an absent value stays absent,
 *  matching the `...(x !== undefined ? { x } : {})` discipline of the prior
 *  AgentRunner opts. `maxTurns` is pinned to the cron default the AgentRunner
 *  path also passed. */
export function buildCronAgentConfig(input: CronAgentConfigInput): AgentConfig {
  return {
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    systemPrompt: input.systemPrompt,
    maxTokens: input.maxTokens,
    maxTurns: DEFAULT_CRON_MAX_TURNS,
    cwd: input.cwd,
    tools: input.tools,
    memoryManager: input.memoryManager,
    ...(input.recall !== undefined ? { recall: input.recall } : {}),
    microcompactConfig: input.microcompactConfig,
    ...(input.transcripts !== undefined ? { transcripts: input.transcripts } : {}),
  };
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

        // The cron turn runs through the open SDK's `createAgent().run()`.
        // The agent loop is IDENTICAL — every prior native turn-loop opt maps 1:1 to
        // `AgentConfig`/`PerTurn` with the SAME value (see `buildCronAgentConfig`)
        // — EXCEPT the two CEO-ratified parity-fixes the AgentRunner surface could
        // not carry:
        //   • microcompactConfig — cron previously ran on query()'s built-in
        //     DEFAULT_MICROCOMPACT_CONFIG (AgentRunner dropped the field); it now
        //     honors the operator's `microcompaction.*` settings via
        //     `runtime.microcompactConfig`, exactly like the turns route.
        //   • transcripts — AgentRunner never persisted and cron never called
        //     `persistMessage`, so a scheduled turn was never transcribed; passing
        //     `runtime.transcripts` writes the cron session's JSONL mirror like an
        //     interactive turn. (No `sessionStore` is passed: cron never wrote
        //     message rows before, so adding DB persistence would be a new
        //     capability, not parity. The session ROW is still minted above.)
        // The cron-filtered tool pool, the auto-deny canUseTool, and the
        // session-scoped ToolContext are handed through VERBATIM via
        // `perTurn.toolContext` / `perTurn.canUseTool`, so cron keeps EXACTLY its
        // current tool + permission wiring and gains no capability beyond the two
        // fixes. Effort is the runtime BOOT DEFAULT (backlog #57): a scheduled job
        // has no interactive session, and `/effort` no longer mutates this shared
        // field, so cron stays isolated from any principal's `/effort`. memory +
        // recall mirror the turns route + channel pipeline (recall conditionally
        // spread so a recall-disabled session stays inert).
        const agent = createAgent(
          buildCronAgentConfig({
            provider: runtime.resolvedProvider.transport as unknown as LLMProvider,
            model: runtime.model,
            effort: runtime.effort,
            systemPrompt: runtime.systemSegments,
            maxTokens: runtime.maxTokens,
            cwd: runtime.cwd,
            tools: cronToolPool,
            memoryManager: sessionCtx.memoryManager,
            ...(sessionCtx.recall !== undefined ? { recall: sessionCtx.recall } : {}),
            microcompactConfig: runtime.microcompactConfig,
            ...(runtime.transcripts !== undefined ? { transcripts: runtime.transcripts } : {}),
          }),
        );

        const gen = agent.run(prompt, { sessionId, toolContext, canUseTool });
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
    runScript: (scriptPath, cwd, timeoutMs) =>
      // Async spawn — never blocks the long-lived process's event loop.
      // All path resolution / interpreter inference / cap / kill semantics
      // live in runCronScript (directly unit-tested).
      runCronScript(harnessHome, scriptPath, cwd, timeoutMs),
  });

  return new CronRunner({
    harnessHome,
    now: () => Date.now(),
    runJob: (job: Job): Promise<CronRunResult> => executor(job),
  });
}
