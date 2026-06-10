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
  runCronScript,
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

describe('runCronScript — async, bounded, capped', () => {
  let scriptHome: string;
  beforeEach(() => {
    scriptHome = mkdtempSync(join(tmpdir(), 'sov-cron-script-'));
  });
  afterEach(() => {
    rmSync(scriptHome, { recursive: true, force: true });
  });

  function writeScript(name: string, body: string): string {
    const fs = require('node:fs') as typeof import('node:fs');
    const dir = join(scriptHome, 'cron', 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, name), body, { encoding: 'utf8', mode: 0o755 });
    return name;
  }

  test('returns stdout on a zero-exit script', async () => {
    const name = writeScript('ok.sh', '#!/bin/bash\necho "hello from script"\n');
    const out = await runCronScript(scriptHome, name, scriptHome, 5000);
    expect(out).toContain('hello from script');
  });

  test('throws on a non-zero exit, surfacing the status + stderr', async () => {
    const name = writeScript('fail.sh', '#!/bin/bash\necho "boom" 1>&2\nexit 3\n');
    await expect(runCronScript(scriptHome, name, scriptHome, 5000)).rejects.toThrow(/exited 3/);
  });

  test('caps oversized stdout by truncation rather than throwing ENOBUFS', async () => {
    // Emit ~64 KiB — well over the 16 KiB cap. spawnSync's maxBuffer would
    // throw ENOBUFS here; the async path must truncate instead.
    const name = writeScript(
      'big.sh',
      '#!/bin/bash\nfor i in $(seq 1 65536); do printf "x"; done\n',
    );
    const out = await runCronScript(scriptHome, name, scriptHome, 10_000);
    // Capped at MAX_SCRIPT_STDOUT (16 KiB); never the full 64 KiB.
    expect(out.length).toBe(16 * 1024);
    expect(out).not.toContain('ENOBUFS');
  });

  test('bounds a long-running script at the timeout and hard-kills it', async () => {
    // A script that ignores SIGTERM and sleeps far past the timeout. The
    // timeout must hard-kill (SIGKILL) and reject — the call must not hang.
    const name = writeScript('hang.sh', '#!/bin/bash\ntrap "" TERM\nsleep 30\n');
    const started = Date.now();
    await expect(runCronScript(scriptHome, name, scriptHome, 400)).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - started;
    // Must return well before the script's 30s sleep — proves the kill landed.
    expect(elapsed).toBeLessThan(5000);
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
