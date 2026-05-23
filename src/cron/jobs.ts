import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeNextRun } from './schedule.js';
import type { Job, JobsFile, ScheduleKind } from './types.js';

function jobsPath(home: string): string {
  return join(home, 'cron', 'jobs.json');
}

// withJobsLock serializes mutations to jobs.json across processes. The lock
// is a directory created with mkdirSync (atomic on POSIX); on EEXIST we
// retry with a short delay up to JOBS_LOCK_MAX_ATTEMPTS times (~1s total
// at 10ms each). The load→modify→save sequence inside the callback is
// expected to take well under one tick, so contention should be rare.
//
// Only mutations (addJob, mutateJob, deleteJob) take the lock. Reads
// (loadJobs, listJobs, getJob) do not — a torn read of jobs.json is
// already prevented by saveJobs's atomic temp+rename, so readers always
// see a consistent snapshot.
const JOBS_LOCK_DIR = '.jobs.lock';
const JOBS_LOCK_MAX_ATTEMPTS = 100;
const JOBS_LOCK_RETRY_MS = 10;

// Busy-wait sleep. We avoid Bun.sleepSync because its minimum granularity
// on macOS/Linux is ~50ms — 100 attempts of "10ms" would actually take 5s,
// not 1s. Busy-wait is uniform and the total worst-case wait is small
// (~1s); contention in practice is very rare. Both approaches block the
// JS event loop (timers/promises won't fire during the wait), so a busy
// loop is no worse in that respect.
function sleepBlocking(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait — acceptable because waits are very short
  }
}

function withJobsLock<T>(home: string, fn: () => T): T {
  const cronDir = join(home, 'cron');
  mkdirSync(cronDir, { recursive: true });
  const lockDir = join(cronDir, JOBS_LOCK_DIR);
  let acquired = false;
  for (let attempt = 0; attempt < JOBS_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        sleepBlocking(JOBS_LOCK_RETRY_MS);
        continue;
      }
      throw err;
    }
  }
  if (!acquired) {
    throw new Error(
      `failed to acquire jobs lock at ${lockDir} after ${JOBS_LOCK_MAX_ATTEMPTS} attempts`,
    );
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* swallow — releasing a lock must never throw */
    }
  }
}

export function loadJobs(home: string): Job[] {
  const path = jobsPath(home);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(raw) as JobsFile;
    return parsed.jobs ?? [];
  } catch (err) {
    // Corrupt jobs.json — surface once on stderr and skip this tick rather
    // than crashing the runtime in a loop. The ticker default-on means
    // a parse error would otherwise produce noisy stderr every 60s.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cron] jobs.json corrupt at ${path}: ${msg}\n`);
    return [];
  }
}

function saveJobs(home: string, jobs: Job[]): void {
  const dir = join(home, 'cron');
  mkdirSync(dir, { recursive: true });
  const path = jobsPath(home);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file: JobsFile = { version: 1, jobs };
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmp, path);
}

export type AddJobInput = {
  prompt: string;
  schedule: ScheduleKind;
  deliver: string;
  skills: string[];
  script?: string;
  scriptTimeoutMs?: number;
};

export function addJob(home: string, input: AddJobInput): Job {
  return withJobsLock(home, () => {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      prompt: input.prompt,
      schedule: input.schedule,
      deliver: input.deliver,
      skills: input.skills,
      ...(input.script !== undefined ? { script: input.script } : {}),
      ...(input.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: input.scriptTimeoutMs } : {}),
      enabled: true,
      nextRunAt: computeNextRun(input.schedule, null, now),
      createdAt: now,
      updatedAt: now,
    };
    const jobs = loadJobs(home);
    jobs.push(job);
    saveJobs(home, jobs);
    return job;
  });
}

export function listJobs(home: string): Job[] {
  return loadJobs(home);
}

export function getJob(home: string, id: string): Job | undefined {
  return loadJobs(home).find((j) => j.id === id);
}

function mutateJob(home: string, id: string, fn: (j: Job) => Job): Job | undefined {
  return withJobsLock(home, () => {
    const jobs = loadJobs(home);
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return undefined;
    const current = jobs[idx];
    if (!current) return undefined;
    const updated: Job = { ...fn(current), updatedAt: Date.now() };
    jobs[idx] = updated;
    saveJobs(home, jobs);
    return updated;
  });
}

export function pauseJob(home: string, id: string): Job | undefined {
  return mutateJob(home, id, (j) => ({ ...j, enabled: false }));
}

export function resumeJob(home: string, id: string): Job | undefined {
  return mutateJob(home, id, (j) => ({ ...j, enabled: true }));
}

export function deleteJob(home: string, id: string): boolean {
  return withJobsLock(home, () => {
    const jobs = loadJobs(home);
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    saveJobs(home, next);
    return true;
  });
}

export function recordJobRun(
  home: string,
  id: string,
  ranAt: number,
  result: NonNullable<Job['lastResult']>,
): Job | undefined {
  return mutateJob(home, id, (j) => ({
    ...j,
    lastRunAt: ranAt,
    lastResult: result,
    nextRunAt: computeNextRun(j.schedule, ranAt, ranAt + 1),
  }));
}
