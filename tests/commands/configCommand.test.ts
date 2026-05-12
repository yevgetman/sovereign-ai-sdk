import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_COMMAND } from '../../src/commands/configCommand.js';
import type { CommandContext } from '../../src/commands/types.js';

let tmpHome: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'sov-cfg-test-'));
  originalEnv = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = tmpHome;
});

afterEach(() => {
  if (originalEnv === undefined) {
    // biome-ignore lint/performance/noDelete: assigning undefined leaves HARNESS_HOME=="undefined" in env
    delete process.env.HARNESS_HOME;
  } else {
    process.env.HARNESS_HOME = originalEnv;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

function fakeCtx(): CommandContext {
  return {
    sessionId: 's',
    cwd: '/tmp',
    providerName: 'anthropic',
    model: 'claude-sonnet-4-6',
    bundlePath: null,
    harnessHome: tmpHome,
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
  };
}

describe('/config', () => {
  test('no-arg shows current config redacted', async () => {
    const out = await CONFIG_COMMAND.call('', fakeCtx());
    expect(out).toContain('{');
  });

  test('"path" returns the config path', async () => {
    const out = await CONFIG_COMMAND.call('path', fakeCtx());
    expect(out).toContain('config.json');
  });

  test('set + get round-trips a primitive', async () => {
    await CONFIG_COMMAND.call('set defaultProvider ollama', fakeCtx());
    const out = await CONFIG_COMMAND.call('get defaultProvider', fakeCtx());
    expect(out).toContain('ollama');
  });

  test('unset removes a key', async () => {
    await CONFIG_COMMAND.call('set defaultProvider ollama', fakeCtx());
    await CONFIG_COMMAND.call('unset defaultProvider', fakeCtx());
    const out = await CONFIG_COMMAND.call('get defaultProvider', fakeCtx());
    expect(out).toContain('undefined');
  });

  test('unknown verb returns usage', async () => {
    const out = await CONFIG_COMMAND.call('frobnicate', fakeCtx());
    expect(out.toLowerCase()).toContain('usage');
  });
});
