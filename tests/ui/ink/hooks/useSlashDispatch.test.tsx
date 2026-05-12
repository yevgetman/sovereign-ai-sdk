import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { HELP_COMMAND, buildCommandRegistry } from '../../../../src/commands/registry.js';
import type { CommandContext } from '../../../../src/commands/types.js';
import { useSlashDispatch } from '../../../../src/ui/ink/hooks/useSlashDispatch.js';
import type { UiEvent } from '../../../../src/ui/ink/state/types.js';

function HostHelp({
  ctx,
  onEvent,
}: {
  ctx: CommandContext;
  onEvent: (e: UiEvent) => void;
}): JSX.Element {
  const { dispatch } = useSlashDispatch(ctx, onEvent);
  React.useEffect(() => {
    void dispatch('/help');
  }, [dispatch]);
  return <></>;
}

describe('useSlashDispatch', () => {
  test('routes /help output to command_output dispatch', async () => {
    const events: UiEvent[] = [];
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
    render(<HostHelp ctx={ctx} onEvent={(e) => events.push(e)} />);
    await new Promise((r) => setTimeout(r, 50));
    const types = events.map((e) => e.type);
    expect(types).toContain('user_input_submitted');
    expect(types).toContain('command_output');
  });
});
