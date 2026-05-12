import { describe, expect, test } from 'bun:test';
import { CLEAR_COMMAND, QUIT_COMMAND } from '../../src/commands/sessionOps.js';
import type { CommandContext } from '../../src/commands/types.js';

function fakeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionId: 'sess',
    cwd: '/tmp',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: null,
    harnessHome: '/tmp/.harness',
    profileName: 'default',
    setModel: () => {},
    clearHistory: () => 'history cleared (3 messages)',
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
    registry: new Map(),
    requestExit: () => {},
    ...overrides,
  };
}

describe('/clear', () => {
  test('invokes ctx.clearHistory and returns its message', async () => {
    let called = 0;
    const ctx = fakeCtx({
      clearHistory: () => {
        called++;
        return 'history cleared (5 messages)';
      },
    });
    const out = await CLEAR_COMMAND.call('', ctx);
    expect(called).toBe(1);
    expect(out).toContain('history cleared');
  });
});

describe('/quit', () => {
  test('invokes ctx.requestExit and returns empty string', async () => {
    let called = 0;
    const ctx = fakeCtx({
      requestExit: () => {
        called++;
      },
    });
    const out = await QUIT_COMMAND.call('', ctx);
    expect(called).toBe(1);
    expect(out).toBe('');
  });

  test('has /exit as an alias', () => {
    expect(QUIT_COMMAND.aliases).toContain('exit');
  });
});
