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
import { resolveProvider } from '../providers/resolver.js';
import { buildSkillCommands } from '../skills/commands.js';
import { loadSkills } from '../skills/loader.js';
import { filterSkillRegistry, inferActiveToolsets } from '../skills/visibility.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';

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
  const loadedSkills = await loadSkills({
    harnessHome,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
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

  const commandRegistry = buildCommandRegistry([...COMMANDS, ...buildSkillCommands(skillRegistry)]);

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
  };

  process.stdout.write(`${READY_MARKER}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of rl) {
      if (exitRequested) break;
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
