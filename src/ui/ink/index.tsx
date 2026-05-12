// Phase 16.0b — Ink TUI entry. startInkTUI() boots the shared harness
// context (daemon, bundle, agents, skills, tool pool, system prompt,
// command registry), builds a query()-backed runner closure that
// maintains conversation history across user turns, and mounts <App />.
// The shared boot path lives in src/commands/dispatchHost.ts so the
// headless `sov dispatch` surface (Phase 16.0c SD1) sees an identical
// CommandContext.

import chalk from 'chalk';
import { render } from 'ink';
import { buildHarnessContext } from '../../commands/dispatchHost.js';
import { query } from '../../core/query.js';
import type { Message, SystemSegment } from '../../core/types.js';
import type { MemoryRuntime } from '../../memory/provider.js';
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
  // Ink-side refs the React tree wires into. Populated below before any
  // user input can arrive — see latestStateRef / uiDispatchRef.
  const latestStateRef: { current: UiState | undefined } = { current: undefined };
  const uiDispatchRef: { current: ((e: UiEvent) => void) | null } = { current: null };

  let exitRequested = false;
  let instance: ReturnType<typeof render> | undefined;

  const harness = await buildHarnessContext({
    ...(opts.bundlePath !== undefined ? { bundlePath: opts.bundlePath } : {}),
    sessionIdPrefix: SESSION_ID_PREFIX,
    getLatestCost: () => latestStateRef.current?.sessionCost,
    onClearHistory: () => {
      uiDispatchRef.current?.({ type: 'transcript_cleared' });
    },
    onModelChange: ({ provider, model }) => {
      uiDispatchRef.current?.({
        type: 'status_line_update',
        patch: { provider, model },
      });
    },
    onExitRequest: () => {
      if (exitRequested) return;
      exitRequested = true;
      // Daemon shutdown happens in cleanup(); we drop the mount here so
      // the Ink waitUntilExit() promise resolves.
      setTimeout(() => instance?.unmount(), 0);
    },
  });

  const runner: AgentTurnRunner = (prompt: string) => {
    harness.history.current.push({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    });
    return runOneTurn({
      history: harness.history.current,
      toolPool: harness.toolPool,
      toolContext: harness.toolContext,
      systemPrompt: harness.systemPrompt,
      provider: harness.providerRef.current,
      model: harness.modelRef.current,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(harness.userSettings.maxTurns !== undefined
        ? { maxTurns: harness.userSettings.maxTurns }
        : {}),
      ...(harness.toolContext.memoryManager !== undefined
        ? { memoryManager: harness.toolContext.memoryManager }
        : {}),
      sessionId: harness.sessionId,
      cacheEnabled: harness.cacheEnabled,
    });
  };

  // Splash banner — same as the prior wiring; written before render() so
  // it lands in scroll-back above Ink's live region.
  const providerName = harness.providerNameRef.current;
  const authLabel = (() => {
    if (providerName === 'ollama') return chalk.gray('local (no key)');
    if (providerName === 'router') return chalk.gray('router-managed');
    return chalk.gray('API Key');
  })();
  const splash = renderSplash({
    providerLabel: providerName,
    authLabel,
    model: harness.modelRef.current,
    bundlePath: harness.bundlePath,
    permissionMode: harness.userSettings.permissionMode ?? 'default',
    toolCount: harness.toolPool.length,
    cacheOn: harness.cacheEnabled,
    sessionLabel: `new ${harness.sessionId.slice(0, 8)}`,
    exitHint: 'Ctrl-C to exit',
  });
  process.stdout.write(`${splash}\n`);

  instance = render(
    <App
      runner={runner}
      bus={harness.daemon.bus}
      cwd={process.cwd()}
      profile={harness.profileName}
      provider={providerName}
      model={harness.modelRef.current}
      commandContext={harness.commandContext}
      latestStateRef={latestStateRef as { current: UiState }}
      uiDispatchRef={uiDispatchRef}
      onExit={harness.commandContext.requestExit}
    />,
  );

  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    await harness.cleanup();
  }
}

type RunOneTurnOpts = {
  readonly history: Message[];
  readonly toolPool: ReadonlyArray<Tool<unknown, unknown>>;
  readonly toolContext: ToolContext;
  readonly systemPrompt: ReadonlyArray<SystemSegment>;
  readonly provider: Parameters<typeof query>[0]['provider'];
  readonly model: string;
  readonly maxTokens: number;
  readonly maxTurns?: number;
  readonly memoryManager?: MemoryRuntime;
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
    systemPrompt: [...opts.systemPrompt],
    ...(opts.toolPool.length > 0
      ? { tools: [...opts.toolPool], toolContext: opts.toolContext }
      : {}),
    maxTokens: opts.maxTokens,
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    cacheEnabled: opts.cacheEnabled,
    ...(opts.memoryManager !== undefined ? { memoryManager: opts.memoryManager } : {}),
    sessionId: opts.sessionId,
    cwd: process.cwd(),
  });

  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
    const ev = step.value;
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
