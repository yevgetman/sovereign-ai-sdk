// Phase 17 T8 — tests for the `sov cron` CLI pure helpers. Each test runs
// against a fresh tmpdir harnessHome so jobs.json state stays hermetic.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatJobLine,
  runCronAdd,
  runCronDelete,
  runCronList,
  runCronPause,
  runCronResume,
  runCronShow,
} from '../../src/cli/cronCommand.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-cron-cli-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('sov cron CLI helpers', () => {
  test('add then list shows the job', () => {
    const job = runCronAdd(home, {
      schedule: '5m',
      prompt: 'check the queue',
      deliver: 'local',
      skills: [],
    });
    expect(job.id).toBeTruthy();
    expect(job.prompt).toBe('check the queue');
    expect(job.schedule).toEqual({ kind: 'relative', offsetMs: 5 * 60_000 });
    const jobs = runCronList(home);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(job.id);
  });

  test('show returns job detail by id', () => {
    const job = runCronAdd(home, {
      schedule: 'every 10m',
      prompt: 'poll metrics',
      deliver: 'local',
      skills: ['observability'],
    });
    const fetched = runCronShow(home, job.id);
    expect(fetched?.id).toBe(job.id);
    expect(fetched?.skills).toEqual(['observability']);
    expect(fetched?.schedule).toEqual({ kind: 'interval', intervalMs: 10 * 60_000 });
  });

  test('pause and resume flip enabled', () => {
    const job = runCronAdd(home, {
      schedule: '1h',
      prompt: 'p',
      deliver: 'local',
      skills: [],
    });
    expect(runCronPause(home, job.id)?.enabled).toBe(false);
    expect(runCronResume(home, job.id)?.enabled).toBe(true);
  });

  test('delete removes the job', () => {
    const job = runCronAdd(home, {
      schedule: '1h',
      prompt: 'p',
      deliver: 'local',
      skills: [],
    });
    expect(runCronDelete(home, job.id)).toBe(true);
    expect(runCronList(home)).toHaveLength(0);
  });

  test('add rejects unknown schedule', () => {
    expect(() =>
      runCronAdd(home, {
        schedule: 'not-a-schedule',
        prompt: 'p',
        deliver: 'local',
        skills: [],
      }),
    ).toThrow(/unparseable schedule/);
  });

  test('delete on missing id returns false', () => {
    expect(runCronDelete(home, 'nope-no-such-id')).toBe(false);
  });

  test('formatJobLine truncates prompt and prints status + next run', () => {
    const job = runCronAdd(home, {
      schedule: '5m',
      prompt: 'a'.repeat(80),
      deliver: 'local',
      skills: [],
    });
    const line = formatJobLine(job);
    expect(line).toContain(job.id.slice(0, 8));
    expect(line).toContain('enabled');
    // Truncated to 40 chars inside the JSON-quoted slice.
    expect(line).toContain(`"${'a'.repeat(40)}"`);
    // nextRunAt is set on first scheduling, so format hits the ISO branch.
    expect(line).toMatch(/next=\d{4}-\d{2}-\d{2}T/);
  });
});
