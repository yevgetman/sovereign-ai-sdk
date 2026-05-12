// Phase 16.0c SD1 — shared boot path that constructs a CommandContext
// from the same minimum context the Ink TUI uses. Both `startInkTUI()`
// (interactive) and `runDispatch()` (headless slash-only) call this so
// the slash-command surface is identical in both modes.
//
// `latestStateRef` + `uiDispatchRef` are caller-supplied: the Ink path
// populates them from the React reducer; the dispatch path passes
// no-op shadows because there is no live UI to reflect events into.

import { loadAgents } from '../agents/loader.js';
import { getDefaultBundlePath } from '../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import { getActiveProfile, resolveHarnessHome } from '../config/paths.js';
import { readConfig } from '../config/store.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { Message, SystemSegment } from '../core/types.js';
import { type DaemonHandle, startDaemon } from '../daemon/runner.js';
import { createDefaultMemoryManager } from '../memory/provider.js';
import { resolveProjectScope } from '../memory/scope.js';
import { resolveProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import { loadSkills } from '../skills/loader.js';
import type { SkillRegistry } from '../skills/types.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { WAVE_1_COMMANDS, buildCommandRegistry } from './registry.js';
import type { CommandContext, PermissionsSnapshot, SessionCost } from './types.js';

export type HarnessContextOpts = {
  readonly bundlePath?: string;
  readonly sessionIdPrefix?: string;
  /** Caller-owned getter returning the latest session cost. CommandContext.getCost
   *  calls this on demand. Ink mirrors the React reducer's `sessionCost`;
   *  the headless dispatch path returns `undefined` (zero-cost fallback). */
  readonly getLatestCost: () => SessionCost | undefined;
  /** Caller-owned hook fired when /clear or /model needs to nudge the UI.
   *  Ink wires this to the reducer dispatch; headless wires it to a no-op. */
  readonly onClearHistory?: () => void;
  /** Caller-owned hook fired when /model swaps provider/model. */
  readonly onModelChange?: (info: { provider: string; model: string }) => void;
  /** Caller-owned exit-request hook; the dispatch driver wires this to
   *  break its stdin loop, the Ink path unmounts the React tree. */
  readonly onExitRequest: () => void;
};

export type HarnessContext = {
  readonly commandContext: CommandContext;
  readonly daemon: DaemonHandle;
  readonly toolPool: ReadonlyArray<Tool<unknown, unknown>>;
  readonly toolContext: ToolContext;
  readonly systemPrompt: ReadonlyArray<SystemSegment>;
  readonly skills: SkillRegistry;
  readonly sessionId: string;
  readonly bundlePath: string | null;
  readonly profileName: string;
  readonly harnessHome: string;
  readonly cacheEnabled: boolean;
  readonly history: { current: Message[] };
  readonly providerRef: { current: LLMProvider };
  readonly modelRef: { current: string };
  readonly providerNameRef: { current: string };
  readonly userSettings: ReturnType<typeof readConfig>;
  readonly cleanup: () => Promise<void>;
};

const DEFAULT_SESSION_ID_PREFIX = 'harness';

/**
 * Boot the harness runtime to the point where a CommandContext is usable.
 * Acquires the daemon lock; loads the bundle, profile, memory manager,
 * agents, skills; resolves the provider; assembles the tool pool; builds
 * the segmented system prompt. Returns the full bundle plus a `cleanup`
 * routine the caller MUST `await` on shutdown (daemon + memory teardown).
 */
export async function buildHarnessContext(opts: HarnessContextOpts): Promise<HarnessContext> {
  const home = resolveHarnessHome();
  const profileName = getActiveProfile();
  const daemon = startDaemon({ harnessHome: home });

  const bundlePath = opts.bundlePath ?? getDefaultBundlePath();
  const bundle = await loadBundleIfPresent(bundlePath);
  const userSettings = readConfig();
  const projectScope = resolveProjectScope({
    cwd: process.cwd(),
    bundle: bundle ?? null,
    harnessHome: home,
  });
  const memoryManager = createDefaultMemoryManager(home, projectScope);
  await memoryManager.initialize();
  await memoryManager.onSessionStart();

  const loadedAgents = await loadAgents({
    harnessHome: home,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
  });
  const loadedSkills = await loadSkills({
    harnessHome: home,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
  });

  const resolved = resolveProvider(undefined, undefined);
  const cacheEnabled = true;
  const sessionIdPrefix = opts.sessionIdPrefix ?? DEFAULT_SESSION_ID_PREFIX;
  const sessionId = `${sessionIdPrefix}-${process.pid}-${Date.now()}`;

  const toolContext: ToolContext = {
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    sessionId,
    harnessHome: home,
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
    cacheEnabled,
    projectScope,
  });

  // Mutable per-session refs read on every turn so /model and /clear take
  // effect on the next user submit. Returned to the caller so the runner
  // closure can see the same instances.
  const history: { current: Message[] } = { current: [] };
  const providerRef: { current: LLMProvider } = { current: resolved.transport };
  const modelRef: { current: string } = { current: resolved.model };
  const providerNameRef: { current: string } = {
    current: String(resolved.metadata.provider ?? ''),
  };

  const getPermissions = (): PermissionsSnapshot => ({
    mode: userSettings.permissionMode ?? 'default',
    layers: [], // Layer loading lands in a later wave.
  });

  const registry = buildCommandRegistry(WAVE_1_COMMANDS);
  const commandContext: CommandContext = {
    sessionId,
    cwd: process.cwd(),
    get providerName() {
      return providerNameRef.current;
    },
    get model() {
      return modelRef.current;
    },
    bundlePath: bundlePath ?? null,
    harnessHome: home,
    profileName,
    setModel: (m: string): void => {
      if (m.includes('/')) {
        const [maybeProvider, maybeModel] = m.split('/', 2) as [string, string];
        const newResolved = resolveProvider(maybeProvider, maybeModel);
        providerRef.current = newResolved.transport;
        modelRef.current = newResolved.model;
        providerNameRef.current = String(newResolved.metadata.provider ?? maybeProvider);
      } else {
        modelRef.current = m;
      }
      opts.onModelChange?.({ provider: providerNameRef.current, model: modelRef.current });
    },
    clearHistory: (): string => {
      const cleared = history.current.length;
      history.current = [];
      opts.onClearHistory?.();
      return `history cleared (${cleared} message${cleared === 1 ? '' : 's'})`;
    },
    getCost: () =>
      opts.getLatestCost() ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedUsd: 0,
      },
    tools: toolPool,
    skills: loadedSkills,
    getPermissions,
    registry,
    requestExit: opts.onExitRequest,
  };

  const cleanup = async (): Promise<void> => {
    daemon.shutdown();
    await memoryManager.onSessionEnd(`${sessionIdPrefix}-exit`);
    await memoryManager.shutdown();
  };

  return {
    commandContext,
    daemon,
    toolPool,
    toolContext,
    systemPrompt,
    skills: loadedSkills,
    sessionId,
    bundlePath: bundlePath ?? null,
    profileName,
    harnessHome: home,
    cacheEnabled,
    history,
    providerRef,
    modelRef,
    providerNameRef,
    userSettings,
    cleanup,
  };
}
