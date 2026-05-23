import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeNextRun } from './schedule.js';
import type { Job, JobsFile, ScheduleKind } from './types.js';

function jobsPath(home: string): string {
  return join(home, 'cron', 'jobs.json');
}

export function loadJobs(home: string): Job[] {
  const path = jobsPath(home);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as JobsFile;
  return parsed.jobs ?? [];
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
}

export function listJobs(home: string): Job[] {
  return loadJobs(home);
}

export function getJob(home: string, id: string): Job | undefined {
  return loadJobs(home).find((j) => j.id === id);
}

function mutateJob(home: string, id: string, fn: (j: Job) => Job): Job | undefined {
  const jobs = loadJobs(home);
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return undefined;
  const current = jobs[idx];
  if (!current) return undefined;
  const updated: Job = { ...fn(current), updatedAt: Date.now() };
  jobs[idx] = updated;
  saveJobs(home, jobs);
  return updated;
}

export function pauseJob(home: string, id: string): Job | undefined {
  return mutateJob(home, id, (j) => ({ ...j, enabled: false }));
}

export function resumeJob(home: string, id: string): Job | undefined {
  return mutateJob(home, id, (j) => ({ ...j, enabled: true }));
}

export function deleteJob(home: string, id: string): boolean {
  const jobs = loadJobs(home);
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  saveJobs(home, next);
  return true;
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
