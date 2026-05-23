// Phase 17 T7 — wiring of CronRunner into buildRuntime lifecycle.
//
// Integration test: build a runtime against the mock provider, add a cron
// job whose schedule fires immediately, drive runDueJobs() manually
// (bypassing the 60s tick interval), and verify the agent ran + the final
// assistant text landed in the cron outbox.
//
// Also covers the pure helpers (`resolveScriptPath`, `inferInterpreter`)
// so a future refactor that touches script execution can't silently break
// the path-resolution rules.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addJob } from '../../src/cron/jobs.js';
import {
  createProductionCronRunner,
  inferInterpreter,
  resolveScriptPath,
} from '../../src/cron/wiring.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('resolveScriptPath', () => {
  test('absolute path passes through unchanged', () => {
    expect(resolveScriptPath('/home/state', '/tmp/run.sh')).toBe('/tmp/run.sh');
  });

  test('relative path anchors under <harnessHome>/cron/scripts/', () => {
    expect(resolveScriptPath('/home/state', 'run.sh')).toBe('/home/state/cron/scripts/run.sh');
  });

  test('nested relative path stays under cron/scripts/', () => {
    expect(resolveScriptPath('/home/state', 'sub/run.sh')).toBe(
      '/home/state/cron/scripts/sub/run.sh',
    );
  });
});

describe('inferInterpreter', () => {
  test('.py → python3', () => {
    expect(inferInterpreter('/x/foo.py')).toEqual(['python3', '/x/foo.py']);
  });

  test('.ts → bun', () => {
    expect(inferInterpreter('/x/foo.ts')).toEqual(['bun', '/x/foo.ts']);
  });

  test('.js → bun', () => {
    expect(inferInterpreter('/x/foo.js')).toEqual(['bun', '/x/foo.js']);
  });

  test('.sh → bash', () => {
    expect(inferInterpreter('/x/foo.sh')).toEqual(['bash', '/x/foo.sh']);
  });

  test('no recognized suffix → direct exec', () => {
    expect(inferInterpreter('/x/foo')).toEqual(['/x/foo']);
  });
});

describe('buildRuntime cronEnabled lifecycle', () => {
  test('cronEnabled: false does not attach a runner', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-cron-off-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
        cronEnabled: false,
      });
      expect(runtime.cronRunner).toBeUndefined();
      await runtime.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('default boot attaches a runner that disposes cleanly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-cron-default-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      expect(runtime.cronRunner).toBeDefined();
      // dispose stops the runner (called inside the disposal closure).
      // The setInterval inside CronRunner.start() is unref()'d so this
      // test would exit even without the explicit stop, but the
      // explicit dispose path is what production hits.
      await runtime.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('createProductionCronRunner — end-to-end agent dispatch', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-cron-e2e-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('addJob + runDueJobs writes final assistant text to outbox', async () => {
    // Build a runtime with cron OFF so the production runner doesn't tick
    // behind our back; we construct a fresh production runner via the
    // public factory and drive runDueJobs() directly.
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });

    try {
      const job = addJob(home, {
        prompt: 'say hello',
        schedule: { kind: 'relative', offsetMs: 0 },
        deliver: 'local',
        skills: [],
      });

      const runner = createProductionCronRunner(runtime, home);
      await runner.runDueJobs();

      // Mock provider emits "Hello world." — should be the file body.
      const outboxDir = join(home, 'cron', 'outbox', job.id);
      const entries = readdirSync(outboxDir);
      expect(entries).toHaveLength(1);
      const firstEntry = entries[0];
      if (firstEntry === undefined) throw new Error('outbox entry missing');
      const body = readFileSync(join(outboxDir, firstEntry), 'utf8');
      expect(body).toBe('Hello world.');
    } finally {
      await runtime.dispose();
    }
  });
});
