// Phase 16.0b — Ink TUI entry. startInkTUI() acquires the daemon lock,
// instantiates the bus + caches, builds a query()-backed runner closure
// that maintains conversation history across user turns, and mounts
// <App runner bus />. The runner mirrors the missionRun.ts setup
// (bundle → provider → toolPool → systemPrompt → query()) — terminalRepl's
// full setup (REPL polish, transcript writer, scheduler, review fork)
// lands in Phase 16.0c.

import chalk from 'chalk';
import { render } from 'ink';
import { loadAgents } from '../../agents/loader.js';
import { getDefaultBundlePath } from '../../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../../bundle/loader.js';
import { WAVE_1_COMMANDS, buildCommandRegistry } from '../../commands/registry.js';
import type { CommandContext, PermissionsSnapshot } from '../../commands/types.js';
import { getActiveProfile, resolveHarnessHome } from '../../config/paths.js';
import { readConfig } from '../../config/store.js';
import { query } from '../../core/query.js';
import { buildSystemSegments } from '../../core/systemPrompt.js';
import type { Message, SystemSegment } from '../../core/types.js';
import { startDaemon } from '../../daemon/runner.js';
import { createDefaultMemoryManager } from '../../memory/provider.js';
import { resolveProjectScope } from '../../memory/scope.js';
import { resolveProvider } from '../../providers/resolver.js';
import type { LLMProvider } from '../../providers/types.js';
import { loadSkills } from '../../skills/loader.js';
import { assembleToolPool } from '../../tool/registry.js';
import type { Tool, ToolContext } from '../../tool/types.js';
import { renderSplash } from '../splash.js';
import { App } from './App.js';
import type { AgentTurnRunner } from './hooks/useAgentTurn.js';
import type { UiEvent, UiState } from './state/types.js';

const DEFAULT_MAX_TOKENS = 4096;
const SESSION_ID_PREFIX = 'ink-tui';

export type StartInkTUIOpts = {
  readonly bundlePath?: string;
};

export async function startInkTUI(opts: StartInkTUIOpts = {}): Promise<number> {
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
  const sessionId = `${SESSION_ID_PREFIX}-${process.pid}-${Date.now()}`;

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

  // Phase 16.0c Wave 1 — mutable runtime state lives in refs at this scope.
  // /clear and /model reach in via CommandContext; the runner reads on each
  // call so changes take effect on the next user turn.
  const historyRef: { current: Message[] } = { current: [] };
  const providerRef: { current: LLMProvider } = { current: resolved.transport };
  const modelRef: { current: string } = { current: resolved.model };
  const providerNameRef: { current: string } = {
    current: String(resolved.metadata.provider ?? ''),
  };

  const runner: AgentTurnRunner = (prompt: string) => {
    historyRef.current.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
    return runOneTurn({
      history: historyRef.current,
      toolPool,
      toolContext,
      systemPrompt,
      provider: providerRef.current,
      model: modelRef.current,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(userSettings.maxTurns !== undefined ? { maxTurns: userSettings.maxTurns } : {}),
      memoryManager,
      sessionId,
      cacheEnabled,
    });
  };

  // Splash banner — same as the prior wiring; written before render() so
  // it lands in scroll-back above Ink's live region.
  const providerName = providerNameRef.current;
  const authLabel = (() => {
    if (providerName === 'ollama') return chalk.gray('local (no key)');
    if (providerName === 'router') return chalk.gray('router-managed');
    return chalk.gray('API Key');
  })();
  const splash = renderSplash({
    providerLabel: providerName,
    authLabel,
    model: modelRef.current,
    bundlePath: bundlePath ?? null,
    permissionMode: userSettings.permissionMode ?? 'default',
    toolCount: toolPool.length,
    cacheOn: cacheEnabled,
    sessionLabel: `new ${sessionId.slice(0, 8)}`,
    exitHint: 'Ctrl-C to exit',
  });
  process.stdout.write(`${splash}\n`);

  // latestStateRef updated by App's effect; CommandContext.getCost reads it.
  // uiDispatchRef written by App on mount so out-of-React callbacks
  // (clearHistory, setModel) can emit reducer events.
  const latestStateRef: { current: UiState | undefined } = { current: undefined };
  const uiDispatchRef: { current: ((e: UiEvent) => void) | null } = { current: null };

  const getPermissions = (): PermissionsSnapshot => ({
    mode: userSettings.permissionMode ?? 'default',
    layers: [], // Loading from settings files lands in a later wave.
  });

  let exitRequested = false;
  let instance: ReturnType<typeof render> | undefined;
  const onExit = (): void => {
    if (exitRequested) return;
    exitRequested = true;
    daemon.shutdown();
    setTimeout(() => instance?.unmount(), 0);
  };

  // Build CommandContext. The registry is self-referential (commands need
  // ctx.registry so /help can introspect), so we build the map first, then
  // the context, then the App.
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
      uiDispatchRef.current?.({
        type: 'status_line_update',
        patch: { provider: providerNameRef.current, model: modelRef.current },
      });
    },
    clearHistory: (): string => {
      const cleared = historyRef.current.length;
      historyRef.current = [];
      uiDispatchRef.current?.({ type: 'transcript_cleared' });
      return `history cleared (${cleared} message${cleared === 1 ? '' : 's'})`;
    },
    getCost: () =>
      latestStateRef.current?.sessionCost ?? {
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
    requestExit: onExit,
  };

  instance = render(
    <App
      runner={runner}
      bus={daemon.bus}
      cwd={process.cwd()}
      profile={profileName}
      provider={providerName}
      model={modelRef.current}
      commandContext={commandContext}
      latestStateRef={latestStateRef as { current: UiState }}
      uiDispatchRef={uiDispatchRef}
      onExit={onExit}
    />,
  );

  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    daemon.shutdown();
    await memoryManager.onSessionEnd('ink-tui-exit');
    await memoryManager.shutdown();
  }
}

type RunOneTurnOpts = {
  readonly history: Message[];
  readonly toolPool: Tool<unknown, unknown>[];
  readonly toolContext: ToolContext;
  readonly systemPrompt: SystemSegment[];
  readonly provider: Parameters<typeof query>[0]['provider'];
  readonly model: string;
  readonly maxTokens: number;
  readonly maxTurns?: number;
  readonly memoryManager: ReturnType<typeof createDefaultMemoryManager>;
  readonly sessionId: string;
  readonly cacheEnabled: boolean;
};

/** Wraps query() so the returned generator appends every yielded
 *  assistant message + tool_result carrier message back into `history`
 *  before yielding it to the consumer. Matches the history-discipline
 *  pattern used in missionRun.ts. */
async function* runOneTurn(opts: RunOneTurnOpts): ReturnType<typeof query> {
  const gen = query({
    provider: opts.provider,
    model: opts.model,
    messages: opts.history,
    systemPrompt: opts.systemPrompt,
    ...(opts.toolPool.length > 0 ? { tools: opts.toolPool, toolContext: opts.toolContext } : {}),
    maxTokens: opts.maxTokens,
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    cacheEnabled: opts.cacheEnabled,
    memoryManager: opts.memoryManager,
    sessionId: opts.sessionId,
    cwd: process.cwd(),
  });

  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
    const ev = step.value;
    // Append assistant_message + tool_result carrier messages into the
    // long-lived history so the next user submit sees the full thread.
    if (ev && typeof ev === 'object') {
      if ('role' in ev && ev.role === 'user') {
        opts.history.push(ev);
      } else if ('type' in ev && ev.type === 'assistant_message') {
        opts.history.push(ev.message);
      }
    }
    yield ev;
  }
}
