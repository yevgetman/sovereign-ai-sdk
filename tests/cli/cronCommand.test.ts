// Phase 17 T8 — tests for the `sov cron` CLI pure helpers. Each test runs
// against a fresh tmpdir harnessHome so jobs.json state stays hermetic.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatJobLine,
  resolveCronJobId,
  runCronAdd,
  runCronDelete,
  runCronList,
  runCronPause,
  runCronResume,
  runCronShow,
} from '../../src/cli/cronCommand.js';

// Minimal Job factory for prefix-collision tests that need controlled ids.
// addJob mints random UUIDs, so tests that must observe the exact-match and
// ambiguous-prefix rules write jobs.json directly with hand-chosen ids.
function makeJob(id: string) {
  return {
    id,
    prompt: 'p',
    schedule: { kind: 'relative' as const, offsetMs: 60_000 },
    deliver: 'local',
    skills: [] as string[],
    enabled: true,
    nextRunAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function seedJobs(home: string, ids: string[]): void {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(join(home, 'cron'), { recursive: true });
  fs.writeFileSync(
    join(home, 'cron', 'jobs.json'),
    JSON.stringify({ version: 1, jobs: ids.map(makeJob) }, null, 2),
    'utf8',
  );
}

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

describe('resolveCronJobId — strict prefix resolution', () => {
  test('the 8-char prefix that list prints resolves back to the full id', () => {
    const job = runCronAdd(home, { schedule: '5m', prompt: 'p', deliver: 'local', skills: [] });
    // formatJobLine prints job.id.slice(0, 8); that exact prefix MUST resolve.
    expect(resolveCronJobId(home, job.id.slice(0, 8))).toBe(job.id);
  });

  test('a full id resolves to itself', () => {
    const job = runCronAdd(home, { schedule: '5m', prompt: 'p', deliver: 'local', skills: [] });
    expect(resolveCronJobId(home, job.id)).toBe(job.id);
  });

  test('an exact id match wins even when it is also a prefix of another id', () => {
    seedJobs(home, ['abc', 'abcdef']);
    // 'abc' is a prefix of 'abcdef' but is also an exact id → exact wins.
    expect(resolveCronJobId(home, 'abc')).toBe('abc');
    // 'abcd' is a unique prefix of 'abcdef' only.
    expect(resolveCronJobId(home, 'abcd')).toBe('abcdef');
  });

  test('an ambiguous prefix throws', () => {
    seedJobs(home, ['dead01', 'dead02']);
    expect(() => resolveCronJobId(home, 'dead')).toThrow(/ambiguous/i);
  });

  test('an unknown prefix throws "no job"', () => {
    runCronAdd(home, { schedule: '5m', prompt: 'p', deliver: 'local', skills: [] });
    expect(() => resolveCronJobId(home, 'zzzzzzzz')).toThrow(/no job/i);
  });
});

describe('show/pause/resume/delete accept prefixes', () => {
  test('all four resolve the short prefix to the full job', () => {
    const job = runCronAdd(home, { schedule: '1h', prompt: 'p', deliver: 'local', skills: [] });
    const prefix = job.id.slice(0, 8);
    expect(runCronShow(home, prefix)?.id).toBe(job.id);
    expect(runCronPause(home, prefix)?.enabled).toBe(false);
    expect(runCronResume(home, prefix)?.enabled).toBe(true);
    expect(runCronDelete(home, prefix)).toBe(true);
    expect(runCronList(home)).toHaveLength(0);
  });

  test('an ambiguous prefix throws across all four', () => {
    seedJobs(home, ['beef01', 'beef02']);
    expect(() => runCronShow(home, 'beef')).toThrow(/ambiguous/i);
    expect(() => runCronPause(home, 'beef')).toThrow(/ambiguous/i);
    expect(() => runCronResume(home, 'beef')).toThrow(/ambiguous/i);
    expect(() => runCronDelete(home, 'beef')).toThrow(/ambiguous/i);
  });

  test('a no-match preserves the legacy contract (undefined / false, no throw)', () => {
    // main.ts relies on runCronShow/Pause/Resume returning undefined and
    // runCronDelete returning false to print "no job <id>" + exit 1. A bare
    // no-match must NOT throw — only an ambiguous prefix does.
    expect(runCronShow(home, 'nope-no-such-id')).toBeUndefined();
    expect(runCronPause(home, 'nope-no-such-id')).toBeUndefined();
    expect(runCronResume(home, 'nope-no-such-id')).toBeUndefined();
    expect(runCronDelete(home, 'nope-no-such-id')).toBe(false);
  });
});
