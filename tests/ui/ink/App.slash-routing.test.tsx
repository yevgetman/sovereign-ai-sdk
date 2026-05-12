import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { HELP_COMMAND, buildCommandRegistry } from '../../../src/commands/registry.js';
import type { CommandContext } from '../../../src/commands/types.js';
import type { Message, StreamEvent, Terminal } from '../../../src/core/types.js';
import type { DaemonEventBus } from '../../../src/daemon/eventBus.js';
import { App } from '../../../src/ui/ink/App.js';

function makeBus(): DaemonEventBus {
  return {
    emit: () => true,
    on: () => () => {},
    off: () => {},
    once: () => () => {},
  } as unknown as DaemonEventBus;
}

// biome-ignore lint/correctness/useYield: stub runner — App renders once and never iterates the generator in this test.
async function* noopRunner(_p: string): AsyncGenerator<StreamEvent | Message, Terminal> {
  return { reason: 'completed' } as Terminal;
}

describe('App slash routing', () => {
  test('renders without crashing with commandContext wired', () => {
    const ctx: CommandContext = {
      sessionId: 's',
      cwd: '/tmp',
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      bundlePath: null,
      harnessHome: '/tmp',
      profileName: 'default',
      setModel: () => {},
      clearHistory: () => 'cleared',
      getCost: () => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedUsd: 0,
      }),
      tools: [],
      skills: { skills: [], byTool: new Map() } as unknown as CommandContext['skills'],
      getPermissions: () => ({ mode: 'default', layers: [] }),
      registry: buildCommandRegistry([HELP_COMMAND]),
      requestExit: () => {},
    };
    const latestStateRef = {
      current: undefined as unknown as Parameters<typeof App>[0]['latestStateRef']['current'],
    };
    const uiDispatchRef: Parameters<typeof App>[0]['uiDispatchRef'] = { current: null };
    const { lastFrame } = render(
      <App
        runner={noopRunner}
        bus={makeBus()}
        cwd="/tmp"
        profile="default"
        provider="anthropic"
        model="claude-sonnet-4-6"
        commandContext={ctx}
        latestStateRef={latestStateRef}
        uiDispatchRef={uiDispatchRef}
        onExit={() => {}}
      />,
    );
    expect(lastFrame()).toBeTruthy();
  });
});
