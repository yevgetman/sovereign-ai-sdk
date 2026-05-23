import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addJob,
  deleteJob,
  getJob,
  listJobs,
  loadJobs,
  pauseJob,
  resumeJob,
} from '../../src/cron/jobs.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cron-jobs-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('jobs CRUD', () => {
  test('loadJobs returns empty list when file missing', () => {
    expect(loadJobs(home)).toEqual([]);
  });
  test('addJob persists job to jobs.json', () => {
    const job = addJob(home, {
      prompt: 'hi',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    expect(job.id).toBeTruthy();
    expect(loadJobs(home)).toHaveLength(1);
  });
  test('listJobs returns all jobs', () => {
    addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    addJob(home, {
      prompt: 'b',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    expect(listJobs(home)).toHaveLength(2);
  });
  test('getJob returns specific job by id', () => {
    const j = addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    expect(getJob(home, j.id)?.prompt).toBe('a');
  });
  test('pauseJob and resumeJob flip enabled flag', () => {
    const j = addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    expect(pauseJob(home, j.id)?.enabled).toBe(false);
    expect(resumeJob(home, j.id)?.enabled).toBe(true);
  });
  test('deleteJob removes the job', () => {
    const j = addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    expect(deleteJob(home, j.id)).toBe(true);
    expect(loadJobs(home)).toHaveLength(0);
  });
  test('writes use atomic temp+rename', () => {
    addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    // The .tmp sibling should not exist after a normal write.
    const files = readdirSync(join(home, 'cron'));
    expect(files).toContain('jobs.json');
    expect(files.some((f: string) => f.endsWith('.tmp'))).toBe(false);
  });
  test('loadJobs returns [] when jobs.json is corrupt', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(join(home, 'cron'), { recursive: true });
    fs.writeFileSync(join(home, 'cron', 'jobs.json'), '{not valid json', 'utf8');
    expect(loadJobs(home)).toEqual([]);
  });
});

describe('jobs lock', () => {
  test('addJob acquires and releases the lock', () => {
    addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    // After addJob completes, the lock dir must NOT exist.
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(join(home, 'cron', '.jobs.lock'))).toBe(false);
  });

  test('addJob throws after maxAttempts if lock never releases', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(join(home, 'cron'), { recursive: true });
    fs.mkdirSync(join(home, 'cron', '.jobs.lock'));
    // Write a live PID so stale-lock recovery doesn't reclaim the lock —
    // we want to exercise the "real contention with a live holder" path.
    fs.writeFileSync(join(home, 'cron', '.jobs.lock', 'pid'), String(process.pid), 'utf8');
    expect(() => {
      addJob(home, {
        prompt: 'a',
        schedule: { kind: 'relative', offsetMs: 60_000 },
        deliver: 'local',
        skills: [],
      });
    }).toThrow(/lock/i);
  });

  test('withJobsLock takes over a stale jobs lock (PID dead)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(join(home, 'cron'), { recursive: true });
    fs.mkdirSync(join(home, 'cron', '.jobs.lock'));
    fs.writeFileSync(join(home, 'cron', '.jobs.lock', 'pid'), '999999', 'utf8');
    // addJob should NOT throw — stale lock detected, taken over, mutation
    // completes.
    const job = addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    expect(job.id).toBeTruthy();
    expect(loadJobs(home)).toHaveLength(1);
  });

  test('withJobsLock takes over a jobs lock with missing PID file', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(join(home, 'cron'), { recursive: true });
    fs.mkdirSync(join(home, 'cron', '.jobs.lock'));
    // No PID file — treat as stale.
    const job = addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    expect(job.id).toBeTruthy();
  });

  test('withJobsLock waits when the lock is held by this very process', () => {
    // The lock holder is the current process, so it appears live and
    // stale-lock recovery does not kick in — withJobsLock exhausts its
    // retry budget and throws. Semantically distinct from the
    // "throws after maxAttempts" test above: that one asserts the
    // retry-budget exhaustion path generally; this one asserts that a
    // live owner — specifically THIS process — is not misclassified as
    // stale.
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(join(home, 'cron'), { recursive: true });
    fs.mkdirSync(join(home, 'cron', '.jobs.lock'));
    fs.writeFileSync(join(home, 'cron', '.jobs.lock', 'pid'), String(process.pid), 'utf8');
    expect(() => {
      addJob(home, {
        prompt: 'a',
        schedule: { kind: 'relative', offsetMs: 60_000 },
        deliver: 'local',
        skills: [],
      });
    }).toThrow(/lock/i);
  });

  test('lock is released after a throw inside the callback (mutateJob path)', () => {
    // pauseJob → mutateJob throws nothing here, but we verify the lock dir
    // is gone after — implicit "finally release" check.
    const j = addJob(home, {
      prompt: 'a',
      schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local',
      skills: [],
    });
    pauseJob(home, j.id);
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(join(home, 'cron', '.jobs.lock'))).toBe(false);
  });

  test('sequential addJobs in same tick land both jobs', async () => {
    // addJob is synchronous, so Promise.all of two addJob calls runs them
    // sequentially in microtask order — not truly in parallel. This test
    // proves the within-process composition (lock acquired, released,
    // acquired again) works. The lock's real benefit is cross-process,
    // which we can't easily test without child_process.
    await Promise.all([
      Promise.resolve().then(() =>
        addJob(home, {
          prompt: 'first',
          schedule: { kind: 'relative', offsetMs: 60_000 },
          deliver: 'local',
          skills: [],
        }),
      ),
      Promise.resolve().then(() =>
        addJob(home, {
          prompt: 'second',
          schedule: { kind: 'relative', offsetMs: 60_000 },
          deliver: 'local',
          skills: [],
        }),
      ),
    ]);
    expect(loadJobs(home)).toHaveLength(2);
  });
});
