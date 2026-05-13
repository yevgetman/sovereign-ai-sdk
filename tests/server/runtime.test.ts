// Phase 16.1 M3.3 — server-side runtime construction.
// buildRuntime() mirrors terminalRepl's boot sequence in a parallel,
// additive form (terminalRepl is untouched per Postmortem Rule 1).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime', () => {
  test('constructs a runtime with sessionDb, toolPool, systemSegments, provider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      expect(rt.sessionDb).toBeDefined();
      expect(rt.toolPool.length).toBeGreaterThan(0);
      expect(rt.systemSegments.length).toBeGreaterThan(0);
      expect(rt.provider).toBeDefined();
      expect(rt.model).toBe('mock-haiku');
      expect(rt.canUseTool).toBeDefined();
      expect(typeof rt.canUseTool).toBe('function');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('honors permissionMode=bypass from user config.json when no option is passed', async () => {
    // Permission cascade: explicit option → layered permission settings →
    // user config.json `permissionMode`. The user-config branch is the
    // one that was missing in M3 and let the TUI hang on tool-using turns.
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-cfg-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ permissionMode: 'bypass' }), 'utf8');
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_CONFIG = configPath;
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: home,
        provider: 'mock',
        model: 'mock-haiku',
      });
      expect(rt.permissionMode).toBe('bypass');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      // biome-ignore lint/performance/noDelete: same.
      delete process.env.HARNESS_CONFIG;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('explicit permissionMode option overrides user config.json', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-override-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ permissionMode: 'bypass' }), 'utf8');
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_CONFIG = configPath;
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: home,
        provider: 'mock',
        model: 'mock-haiku',
        permissionMode: 'ask',
      });
      // Explicit non-default option wins over the bypass set in config.json.
      expect(rt.permissionMode).toBe('ask');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      // biome-ignore lint/performance/noDelete: same.
      delete process.env.HARNESS_CONFIG;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls through to default when neither option nor config sets permissionMode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-default-'));
    // Empty config file (no permissionMode).
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({}), 'utf8');
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    process.env.HARNESS_CONFIG = configPath;
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        cwd: home,
        provider: 'mock',
        model: 'mock-haiku',
      });
      expect(rt.permissionMode).toBe('default');
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      // biome-ignore lint/performance/noDelete: same.
      delete process.env.HARNESS_CONFIG;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
