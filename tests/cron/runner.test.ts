import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addJob, pauseJob } from '../../src/cron/jobs.js';
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

describe('CronRunner.forceRunJob', () => {
  test('fires the named job even if not due', async () => {
    const job = addJob(home, {
      prompt: 'echo',
      schedule: { kind: 'relative', offsetMs: 60 * 60_000 }, // 1 hour from now — not due
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
    const result = await runner.forceRunJob(job.id);
    expect(result.ok).toBe(true);
    expect(runs).toEqual([job.id]);
  });

  test('fires the named job even when paused', async () => {
    const job = addJob(home, {
      prompt: 'echo',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });
    pauseJob(home, job.id);
    const runs: string[] = [];
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now(),
      runJob: async (j) => {
        runs.push(j.id);
        return { ok: true, durationMs: 1 };
      },
    });
    await runner.forceRunJob(job.id);
    expect(runs).toEqual([job.id]);
  });

  test('does not run other due jobs', async () => {
    const target = addJob(home, {
      prompt: 'target',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });
    const other = addJob(home, {
      prompt: 'other',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });
    const runs: string[] = [];
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now() + 60_000 + 1000, // both due
      runJob: async (j) => {
        runs.push(j.id);
        return { ok: true, durationMs: 1 };
      },
    });
    await runner.forceRunJob(target.id);
    expect(runs).toEqual([target.id]); // only the named one
    expect(runs).not.toContain(other.id);
  });

  test('returns ok:false when id does not exist', async () => {
    const runner = new CronRunner({
      harnessHome: home,
      now: () => Date.now(),
      runJob: async () => ({ ok: true, durationMs: 1 }),
    });
    const result = await runner.forceRunJob('nonexistent-id');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
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

  test('tick() skips running due jobs while another holder owns the tick lock', async () => {
    // Contract the `sov cron tick` CLI relies on: tick() must honor the
    // cross-process lock so a manual tick can't double-fire a job already
    // being processed by a live scheduler loop. (runDueJobs() does NO locking,
    // which is why the CLI must call tick(), not runDueJobs().)
    const job = addJob(home, {
      prompt: 'echo',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local',
      skills: [],
    });
    const runs: string[] = [];
    const mkRunner = () =>
      new CronRunner({
        harnessHome: home,
        now: () => Date.now() + 1000,
        runJob: async (j) => {
          runs.push(j.id);
          return { ok: true, durationMs: 1 };
        },
      });
    const holder = mkRunner();
    expect(holder.tryAcquireTickLock()).toBe(true); // a live process owns the lock
    const other = mkRunner();
    await other.tick();
    expect(runs).toEqual([]); // lock held → tick skipped, job not fired
    holder.releaseTickLock();
    await other.tick();
    expect(runs).toEqual([job.id]); // lock free → tick runs the due job
  });

  test('tryAcquireTickLock takes over a stale lock (PID dead)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const cronDir = join(home, 'cron');
    const lockDir = join(cronDir, '.tick.lock');
    fs.mkdirSync(cronDir, { recursive: true });
    fs.mkdirSync(lockDir);
    // Write a PID that doesn't exist. PID 1 is init/launchd (always alive)
    // so we want a likely-dead PID. Pick something extremely high — PIDs
    // typically don't exceed 99999 on macOS/Linux defaults.
    fs.writeFileSync(join(lockDir, 'pid'), '999999', 'utf8');
    const runner = new CronRunner({
      harnessHome: home,
      now: () => 0,
      runJob: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(runner.tryAcquireTickLock()).toBe(true);
    runner.releaseTickLock();
  });

  test('tryAcquireTickLock returns false when the holder is THIS process', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const cronDir = join(home, 'cron');
    const lockDir = join(cronDir, '.tick.lock');
    fs.mkdirSync(cronDir, { recursive: true });
    fs.mkdirSync(lockDir);
    // Write our own PID — guaranteed alive.
    fs.writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
    const runner = new CronRunner({
      harnessHome: home,
      now: () => 0,
      runJob: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(runner.tryAcquireTickLock()).toBe(false);
  });

  test('tryAcquireTickLock takes over a lock with missing PID file', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const cronDir = join(home, 'cron');
    const lockDir = join(cronDir, '.tick.lock');
    fs.mkdirSync(cronDir, { recursive: true });
    fs.mkdirSync(lockDir); // No PID file inside — treat as stale.
    const runner = new CronRunner({
      harnessHome: home,
      now: () => 0,
      runJob: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(runner.tryAcquireTickLock()).toBe(true);
    runner.releaseTickLock();
  });
});
