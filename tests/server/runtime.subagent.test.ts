// Phase 16.1 M5 T6 — buildRuntime constructs SubagentScheduler +
// LaneSemaphores + write-path Semaphore(1) and exposes them on Runtime.
// T7 wires TaskManager on top; T8 plumbs the trio into toolContext at
// query() time. This test only asserts construction.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('runtime — sub-agent scheduler construction', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-sched-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-sched-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('Runtime exposes subagentScheduler, laneSemaphores, writeLock', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.subagentScheduler).toBeDefined();
    expect(runtime.laneSemaphores).toBeDefined();
    expect(runtime.writeLock).toBeDefined();
    expect(typeof runtime.subagentScheduler.delegate).toBe('function');

    await runtime.dispose();
  });
});
