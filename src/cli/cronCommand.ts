// Phase 17 T8 — pure helpers behind the `sov cron` Commander subcommands.
//
// Commander handlers in src/main.ts resolve `resolveHarnessHome()` and pass
// it in explicitly so these helpers stay trivially testable (no env munging,
// no process.cwd reliance). The helpers wrap the CRUD ops in src/cron/jobs.ts
// and reuse parseSchedule from src/cron/schedule.ts for input validation.
//
// `getJob`-by-full-id matches the v0 jobs.ts contract; partial-id matching
// (e.g. last 8 chars) is a follow-up.

import { addJob, deleteJob, getJob, listJobs, pauseJob, resumeJob } from '../cron/jobs.js';
import { parseSchedule } from '../cron/schedule.js';
import type { Job } from '../cron/types.js';

export type CronAddInput = {
  schedule: string;
  prompt: string;
  deliver: string;
  skills: string[];
  script?: string;
  scriptTimeoutMs?: number;
};

export function runCronAdd(harnessHome: string, input: CronAddInput): Job {
  const schedule = parseSchedule(input.schedule);
  return addJob(harnessHome, {
    prompt: input.prompt,
    schedule,
    deliver: input.deliver,
    skills: input.skills,
    ...(input.script !== undefined ? { script: input.script } : {}),
    ...(input.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: input.scriptTimeoutMs } : {}),
  });
}

export function runCronList(harnessHome: string): Job[] {
  return listJobs(harnessHome);
}

export function runCronShow(harnessHome: string, id: string): Job | undefined {
  return getJob(harnessHome, id);
}

export function runCronPause(harnessHome: string, id: string): Job | undefined {
  return pauseJob(harnessHome, id);
}

export function runCronResume(harnessHome: string, id: string): Job | undefined {
  return resumeJob(harnessHome, id);
}

export function runCronDelete(harnessHome: string, id: string): boolean {
  return deleteJob(harnessHome, id);
}

export function formatJobLine(job: Job): string {
  const status = job.enabled ? 'enabled' : 'paused';
  const next = job.nextRunAt ? new Date(job.nextRunAt).toISOString() : 'never';
  return `${job.id.slice(0, 8)}  ${status.padEnd(8)} next=${next}  prompt=${JSON.stringify(job.prompt.slice(0, 40))}`;
}
