// Phase 16.1 M3.3 — server-side runtime construction.
// buildRuntime() mirrors terminalRepl's boot sequence in a parallel,
// additive form (terminalRepl is untouched per Postmortem Rule 1).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
      await rt.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
