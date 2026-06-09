// `sov dispatch` — first-principles headless slash-command surface.
//
// Boots the minimum context required for the existing slash command
// registry to evaluate: bundle, profile, harness home, provider, agents,
// skills, memory manager, tool pool, system prompt, permission settings.
// Does NOT boot: session DB, compactor, task manager, review manager,
// agent loop. Commands that depend on those subsystems error
// informatively; read-only commands work identically to the interactive
// REPL.
//
// Protocol (for semantic tests + scripted callers):
//   1. Boot completes → READY_MARKER on its own line.
//   2. For each newline-delimited stdin command:
//      a. dispatchSlashCommand runs.
//      b. result.output prints (or `error: <msg>` on throw).
//      c. TURN_SEPARATOR prints on its own line.
//   3. On stdin EOF or after `/quit` runs: clean exit, return 0.

import { createInterface } from 'node:readline/promises';
import { loadAgents } from '../agents/loader.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import { COMMANDS, buildCommandRegistry, dispatchSlashCommand } from '../commands/registry.js';
import type { CommandContext } from '../commands/types.js';
import { resolveHarnessHome } from '../config/paths.js';
import { loadPermissionSettings } from '../config/settings.js';
import { readConfig } from '../config/store.js';
import { auditContextBudget } from '../context/budget.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { SystemSegment } from '../core/types.js';
import { createDefaultMemoryManager } from '../memory/provider.js';
import { resolveProjectScope } from '../memory/scope.js';
import { loadPluginRuntime } from '../plugins/runtime.js';
import { resolveProvider } from '../providers/resolver.js';
import { buildSkillCommands } from '../skills/commands.js';
import { loadSkills } from '../skills/loader.js';
import { filterSkillRegistry, inferActiveToolsets } from '../skills/visibility.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { buildDispatchConfirm } from './dispatchConfirm.js';

export const READY_MARKER = '--- ready ---';
export const TURN_SEPARATOR = '--- end-of-turn ---';

export type DispatchOpts = {
  readonly bundlePath?: string;
};

export async function runDispatch(opts: DispatchOpts = {}): Promise<number> {
  const harnessHome = resolveHarnessHome();
  const bundle = await loadBundleIfPresent(opts.bundlePath ?? null);
  const userSettings = readConfig();
  const permissionSettings = loadPermissionSettings({ cwd: process.cwd(), harnessHome });
  const projectScope = resolveProjectScope({
    cwd: process.cwd(),
    bundle: bundle ?? null,
    harnessHome,
  });
  const memoryManager = createDefaultMemoryManager(harnessHome, projectScope);
  await memoryManager.initialize();
  const loadedAgents = await loadAgents({
    harnessHome,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
  });
  // Plugin System v1 (T8) — discover + gate plugins, compose contributions
  // BEFORE loadSkills so plugin skillRoots splice into the registry. The SAME
  // shared helper buildRuntime uses, so the surfaces can't drift. Backlog #55 —
  // config from the resolved harnessHome, not the global. H4 — only skills +
  // commands are consumed; disclosed hooks/mcp are never wired.
  const { contributions: pluginContributions } = await loadPluginRuntime({
    harnessHome,
    config: userSettings.plugins ?? {},
    warn: (msg) => process.stderr.write(`[plugins] ${msg}\n`),
  });

  const loadedSkills = await loadSkills({
    harnessHome,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    extraRoots: pluginContributions.skillRoots,
  });

  const resolved = resolveProvider(userSettings.defaultProvider, userSettings.defaultModel);
  const sessionId = `dispatch-${process.pid}-${Date.now()}`;

  const toolContext: ToolContext = {
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    sessionId,
    harnessHome,
    memoryManager,
    agents: loadedAgents,
    projectScope,
  };
  const toolPool: Tool<unknown, unknown>[] = assembleToolPool(toolContext);
  const systemPrompt: SystemSegment[] = buildSystemSegments({
    ...(bundle ? { bundle } : {}),
    tools: toolPool,
    skills: loadedSkills.skills,
    cwd: process.cwd(),
    cacheEnabled: false,
    projectScope,
  });

  // Mutable runtime state. /clear and /model reach in via the
  // CommandContext getters/setters.
  const modelRef = { current: resolved.model };
  const providerNameRef = { current: String(resolved.metadata.provider ?? '') };

  let exitRequested = false;

  // Permission state — pulled from settings.json layers + config.json
  // fallback. Session-scoped 'alwaysAllow' rules are empty because
  // dispatch mode never runs the agent loop that would accumulate them.
  const permissionMode =
    permissionSettings.mode !== 'default'
      ? permissionSettings.mode
      : (userSettings.permissionMode ?? 'default');

  // Filter skills to the active toolset, matching the REPL's per-turn
  // visibility pattern. Used both by /skills and by buildSkillCommands.
  const activeToolNames = toolPool.map((t) => t.name);
  const activeToolsets = inferActiveToolsets(activeToolNames);
  const skillRegistry = filterSkillRegistry(loadedSkills, activeToolsets, activeToolNames);

  // Plugin System v1 (T8) — built-in COMMANDS first (they ALWAYS win a name
  // collision — buildCommandRegistry is first-wins), then plugin commands, then
  // skill-derived. Mirrors the server command seam's order exactly.
  const commandRegistry = buildCommandRegistry([
    ...COMMANDS,
    ...pluginContributions.commands,
    ...buildSkillCommands(skillRegistry),
  ]);

  // Create the readline interface + a SINGLE stdin consumer (the async
  // iterator) BEFORE the CommandContext. The dispatch loop below and
  // `/plugins install`'s TTY consent prompt (S3) BOTH read through this one
  // `readLine` — sharing one consumer avoids the stdin-contention bug where a
  // second readline (or a concurrent `rl.question()` against an actively-
  // iterated interface) fights for / closes the input. On a non-TTY stdin
  // (scripted / piped), buildDispatchConfirm returns undefined and `/plugins
  // install` refuses with its "requires a terminal" message rather than
  // silently consenting.
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const lineIterator = rl[Symbol.asyncIterator]();
  const readLine = async (): Promise<string | null> => {
    const next = await lineIterator.next();
    return next.done ? null : next.value;
  };
  const confirm = buildDispatchConfirm(readLine, process.stdin.isTTY === true);

  const commandContext: CommandContext = {
    sessionId,
    cwd: process.cwd(),
    get providerName() {
      return providerNameRef.current;
    },
    get model() {
      return modelRef.current;
    },
    bundlePath: opts.bundlePath ?? null,
    harnessHome,
    // Plugin System v1 (T8) — the TTY consent prompt for `/plugins install`.
    // Conditionally spread so the key is ABSENT (not `undefined`) on a non-TTY
    // stdin — install then refuses. exactOptionalPropertyTypes-safe.
    ...(confirm ? { confirm } : {}),
    setModel: (m: string): void => {
      if (m.includes('/')) {
        const [maybeProvider, maybeModel] = m.split('/', 2) as [string, string];
        const newResolved = resolveProvider(maybeProvider, maybeModel);
        modelRef.current = newResolved.model;
        providerNameRef.current = String(newResolved.metadata.provider ?? maybeProvider);
      } else {
        modelRef.current = m;
      }
    },
    clearHistory: () => 'history cleared (dispatch mode — no in-memory history)',
    getCost: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0,
      compactionInputTokens: 0,
      compactionOutputTokens: 0,
      estimatedCompactionCostUsd: 0,
    }),
    compact: async () => {
      throw new Error(
        'dispatch mode does not maintain a session DB — /compact requires the interactive sov session',
      );
    },
    rollback: async () => {
      throw new Error(
        'dispatch mode does not maintain a session DB — /rollback requires the interactive sov session',
      );
    },
    tools: toolPool,
    registry: commandRegistry,
    listSessions: () => [],
    getMetrics: () => ({
      sessionId,
      startedAtMs: Date.now(),
      agentActiveMs: 0,
      apiTimeMs: 0,
      toolTimeMs: 0,
      toolCalls: 0,
      toolOk: 0,
      toolErr: 0,
    }),
    skills: skillRegistry,
    getLastAssistantText: () => null,
    getMessages: () => [],
    getPermissions: () => ({
      mode: permissionMode,
      alwaysAllow: [],
      layers: permissionSettings.layers,
    }),
    requestExit: (): void => {
      exitRequested = true;
    },
    getBudgetReport: () =>
      auditContextBudget({
        systemSegments: systemPrompt,
        tools: toolPool,
        skills: skillRegistry.skills,
        ...(bundle ? { bundle } : {}),
        activeToolNames: toolPool.map((t) => t.name),
      }),
    expandToolBlock: () => ({ ok: false, total: 0 }),
    // Phase 2 T9 — `getRoutingStats` is intentionally omitted in
    // dispatch mode: the routing-atoms surface lives on sessionDb,
    // and dispatch does NOT boot a session DB (see file-level
    // comment). The `/routing-stats` command checks for undefined
    // and surfaces a fallback ("routing-stats is not wired in this
    // surface"), matching how /compact and /rollback already behave
    // when their dependencies are unavailable here.
  };

  process.stdout.write(`${READY_MARKER}\n`);

  try {
    // Pull each command line through the shared `readLine` (the SAME consumer
    // `confirm` reads from). A `null` return is EOF — exit cleanly. A command
    // handler may itself call `readLine` (via `ctx.confirm`) to read its own
    // follow-up line (e.g. the `/plugins install` y/N answer); because there is
    // exactly one iterator, that nested read simply consumes the next line and
    // the loop resumes with the line after it — no contention.
    for (;;) {
      if (exitRequested) break;
      const line = await readLine();
      if (line === null) break;
      const trimmed = line.trim();
      if (!trimmed) {
        process.stdout.write(`${TURN_SEPARATOR}\n`);
        continue;
      }
      try {
        const result = await dispatchSlashCommand(trimmed, commandContext);
        if (result.kind === 'prompt') {
          process.stdout.write(
            `[dispatch mode] prompt commands ('${result.command.name}') require the interactive sov session — skipped\n`,
          );
        } else {
          process.stdout.write(`${result.output}\n`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`error: ${msg}\n`);
      }
      process.stdout.write(`${TURN_SEPARATOR}\n`);
      if (exitRequested) break;
    }
    return 0;
  } finally {
    rl.close();
    await memoryManager.shutdown();
  }
}
