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
import { getActiveProfile, resolveHarnessHome } from '../../config/paths.js';
import { readConfig } from '../../config/store.js';
import { query } from '../../core/query.js';
import { buildSystemSegments } from '../../core/systemPrompt.js';
import type { Message, SystemSegment } from '../../core/types.js';
import { startDaemon } from '../../daemon/runner.js';
import { createDefaultMemoryManager } from '../../memory/provider.js';
import { resolveProjectScope } from '../../memory/scope.js';
import { resolveProvider } from '../../providers/resolver.js';
import { loadSkills } from '../../skills/loader.js';
import { assembleToolPool } from '../../tool/registry.js';
import type { Tool, ToolContext } from '../../tool/types.js';
import { renderSplash } from '../splash.js';
import { App } from './App.js';
import type { AgentTurnRunner } from './hooks/useAgentTurn.js';

const DEFAULT_MAX_TOKENS = 4096;
const SESSION_ID_PREFIX = 'ink-tui';

export type StartInkTUIOpts = {
  readonly bundlePath?: string;
};

export async function startInkTUI(opts: StartInkTUIOpts = {}): Promise<number> {
  const home = resolveHarnessHome();
  const profileName = getActiveProfile();
  const daemon = startDaemon({ harnessHome: home });

  // Bundle, agents, skills, memory, provider — minimal viable setup
  // mirroring the missionRun.ts prologue. terminalRepl's richer flows
  // (sessions, MCP, hooks, trace writer, scheduler, review fork) are
  // deferred to Phase 16.0c.
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

  // Multi-turn history. The runner closure mutates this array across
  // user submits so the next query() call sees the full conversation.
  // query() returns a fresh internal copy each call, so the assistant
  // messages and tool_result carrier messages it yields are appended
  // here as they arrive.
  const history: Message[] = [];

  const runner: AgentTurnRunner = (prompt: string) => {
    history.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
    return runOneTurn({
      history,
      toolPool,
      toolContext,
      systemPrompt,
      provider: resolved.transport,
      model: resolved.model,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(userSettings.maxTurns !== undefined ? { maxTurns: userSettings.maxTurns } : {}),
      memoryManager,
      sessionId,
      cacheEnabled,
    });
  };

  // Render the SOV splash banner to stdout before Ink takes over. Ink's
  // default `render()` is inline (not alternate-screen), so anything
  // written here lands in scroll-back above Ink's live region — matching
  // the visual the readline REPL produced before Phase 16.0b.
  const providerName = String(resolved.metadata.provider ?? '');
  const authLabel = (() => {
    if (providerName === 'ollama') return chalk.gray('local (no key)');
    if (providerName === 'router') return chalk.gray('router-managed');
    return chalk.gray('API Key');
  })();
  const splash = renderSplash({
    providerLabel: providerName,
    authLabel,
    model: resolved.model,
    bundlePath: bundlePath ?? null,
    permissionMode: userSettings.permissionMode ?? 'default',
    toolCount: toolPool.length,
    cacheOn: cacheEnabled,
    sessionLabel: `new ${sessionId.slice(0, 8)}`,
    exitHint: 'Ctrl-C to exit',
  });
  process.stdout.write(`${splash}\n`);

  const instance = render(
    <App
      runner={runner}
      bus={daemon.bus}
      cwd={process.cwd()}
      profile={profileName}
      provider={providerName}
      model={resolved.model}
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
