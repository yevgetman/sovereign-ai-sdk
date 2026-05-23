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
});
