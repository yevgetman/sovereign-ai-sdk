import { describe, expect, test } from 'bun:test';
import { CLEAR_COMMAND, COST_COMMAND, QUIT_COMMAND } from '../../src/commands/sessionOps.js';
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

describe('/cost', () => {
  test('renders token totals and USD estimate', async () => {
    const ctx = fakeCtx({
      getCost: () => ({
        inputTokens: 1500,
        outputTokens: 320,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        estimatedUsd: 0.0042,
      }),
    });
    const out = await COST_COMMAND.call('', ctx);
    expect(out).toContain('input: 1,500');
    expect(out).toContain('output: 320');
    expect(out).toContain('cache read: 100');
    expect(out).toContain('cache write: 50');
    expect(out).toContain('$0.0042');
  });

  test('renders $0.00 when no usage yet', async () => {
    const ctx = fakeCtx();
    const out = await COST_COMMAND.call('', ctx);
    expect(out).toContain('input: 0');
    expect(out).toContain('$0.0000');
  });
});
