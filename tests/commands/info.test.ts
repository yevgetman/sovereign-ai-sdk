import { describe, expect, test } from 'bun:test';
import { ABOUT_COMMAND } from '../../src/commands/info.js';
import type { CommandContext } from '../../src/commands/types.js';

function fakeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionId: 'sess-abc12345',
    cwd: '/tmp/work',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: '/tmp/bundle',
    harnessHome: '/tmp/.harness',
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
    registry: new Map(),
    requestExit: () => {},
    ...overrides,
  };
}

describe('/about', () => {
  test('prints harness identity fields', async () => {
    const out = await ABOUT_COMMAND.call('', fakeCtx());
    expect(out).toContain('sovereign-ai-harness');
    expect(out).toContain('profile: default');
    expect(out).toContain('provider: anthropic');
    expect(out).toContain('model: claude-sonnet-4-6');
    expect(out).toContain('bundle: /tmp/bundle');
    expect(out).toContain('cwd: /tmp/work');
  });

  test('renders "no bundle" when bundlePath is null', async () => {
    const out = await ABOUT_COMMAND.call('', fakeCtx({ bundlePath: null }));
    expect(out).toContain('bundle: no bundle');
  });
});
