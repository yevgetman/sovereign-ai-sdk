import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addJob } from '../../src/cron/jobs.js';
import { CronRunner } from '../../src/cron/runner.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cron-runner-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('CronRunner.runDueJobs', () => {
  test('runs a single due job', async () => {
    const job = addJob(home, {
      prompt: 'echo',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });
    const runs: string[] = [];
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now() + 1000,
      runJob: async (j) => {
        runs.push(j.id);
        return { ok: true, output: 'done', durationMs: 1 };
      },
    });
    await runner.runDueJobs();
    expect(runs).toEqual([job.id]);
  });

  test('skips jobs not yet due', async () => {
    addJob(home, {
      prompt: 'echo',
      schedule: { kind: 'relative', offsetMs: 60 * 60_000 },
      deliver: 'local',
      skills: [],
    });
    const runs: string[] = [];
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now(),
      runJob: async (j) => {
        runs.push(j.id);
        return { ok: true, durationMs: 1 };
      },
    });
    await runner.runDueJobs();
    expect(runs).toEqual([]);
  });

  test('skips paused jobs', async () => {
    const j = addJob(home, {
      prompt: 'echo',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });
    const { pauseJob } = require('../../src/cron/jobs.js');
    pauseJob(home, j.id);
    const runs: string[] = [];
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now() + 1000,
      runJob: async (job) => {
        runs.push(job.id);
        return { ok: true, durationMs: 1 };
      },
    });
    await runner.runDueJobs();
    expect(runs).toEqual([]);
  });

  test('updates lastRunAt and nextRunAt after a run', async () => {
    const j = addJob(home, {
      prompt: 'echo',
      schedule: { kind: 'interval', intervalMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    const fixedNow = Date.now() + 60_000;
    const runner = new CronRunner({
      harnessHome: home,
      now: () => fixedNow,
      runJob: async () => ({ ok: true, durationMs: 1 }),
    });
    await runner.runDueJobs();
    const { getJob } = require('../../src/cron/jobs.js');
    const after = getJob(home, j.id);
    expect(after?.lastRunAt).toBe(fixedNow);
    expect(after?.nextRunAt).toBe(fixedNow + 60_000);
  });
});

describe('CronRunner file-lock', () => {
  test('tryAcquireTickLock returns true on first call, false on overlap', () => {
    const r1 = new CronRunner({
      harnessHome: home,
      now: () => 0,
      runJob: async () => ({ ok: true, durationMs: 1 }),
    });
    const r2 = new CronRunner({
      harnessHome: home,
      now: () => 0,
      runJob: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(r1.tryAcquireTickLock()).toBe(true);
    expect(r2.tryAcquireTickLock()).toBe(false);
    r1.releaseTickLock();
    expect(r2.tryAcquireTickLock()).toBe(true);
    r2.releaseTickLock();
  });
});
