// Phase 17 T8 — pure helpers behind the `sov cron` Commander subcommands.
//
// Commander handlers in src/main.ts resolve `resolveHarnessHome()` and pass
// it in explicitly so these helpers stay trivially testable (no env munging,
// no process.cwd reliance). The helpers wrap the CRUD ops in src/cron/jobs.ts
// and reuse parseSchedule from src/cron/schedule.ts for input validation.
//
// `getJob`-by-full-id matches the v0 jobs.ts contract. `sov cron list` only
// ever prints an 8-char id prefix (see formatJobLine), so every id-taking
// subcommand resolves a given id-or-prefix against the full job set before
// dispatching: an exact id wins; otherwise a unique prefix resolves to its
// full id; an ambiguous prefix is an error. This keeps the short ids the
// operator copies from `list` usable in show/pause/resume/delete/run.

import { addJob, deleteJob, getJob, listJobs, pauseJob, resumeJob } from '../cron/jobs.js';
import { parseSchedule } from '../cron/schedule.js';
import type { Job } from '../cron/types.js';

/** Outcome of matching an id-or-prefix against the known job ids. `kind`
 *  distinguishes the three cases callers care about: a resolved id, no
 *  match at all, or an ambiguous prefix (which is always an error). */
type PrefixMatch =
  | { kind: 'resolved'; id: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: string[] };

/** Pure core: match `idOrPrefix` against `ids`. Exact match wins outright —
 *  even when the same string is also a prefix of a longer id — so a full id
 *  is never misclassified as ambiguous. Otherwise: zero prefix matches →
 *  `none`; exactly one → `resolved`; two or more → `ambiguous`. */
export function matchJobIdPrefix(ids: readonly string[], idOrPrefix: string): PrefixMatch {
  if (ids.includes(idOrPrefix)) return { kind: 'resolved', id: idOrPrefix };
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) {
    const only = matches[0];
    // `only` is statically `string | undefined` under noUncheckedIndexedAccess;
    // length === 1 guarantees presence but TS can't see that.
    return only !== undefined ? { kind: 'resolved', id: only } : { kind: 'none' };
  }
  return { kind: 'ambiguous', matches };
}

/** Build the shared "ambiguous prefix" error (listing the colliding short
 *  ids) so the strict + loose resolvers can't drift. */
function ambiguousPrefixError(idOrPrefix: string, matches: string[]): Error {
  return new Error(
    `ambiguous prefix "${idOrPrefix}" matches ${matches.length} jobs: ${matches
      .map((id) => id.slice(0, 8))
      .join(', ')}`,
  );
}

/** Strict resolver for the `run` path (and any caller that wants a hard
 *  error on a miss): an ambiguous prefix throws; no match throws "no job".
 *  Returns the full id on success. main.ts's `cron run` dispatches to
 *  `forceRunJob`, which matches by full id only — wrap the id arg in this to
 *  give `run` the same prefix support as show/pause/resume/delete. */
export function resolveCronJobId(harnessHome: string, idOrPrefix: string): string {
  const ids = listJobs(harnessHome).map((j) => j.id);
  const match = matchJobIdPrefix(ids, idOrPrefix);
  if (match.kind === 'ambiguous') throw ambiguousPrefixError(idOrPrefix, match.matches);
  if (match.kind === 'none') throw new Error(`no job with id or prefix "${idOrPrefix}"`);
  return match.id;
}

/** Loose resolver for the show/pause/resume/delete helpers: an ambiguous
 *  prefix still throws, but a bare no-match returns `idOrPrefix` UNCHANGED so
 *  the downstream jobs.ts op produces its existing `undefined`/`false` "not
 *  found" result. This preserves the legacy CLI contract (main.ts prints
 *  "no job <id>" + exits 1) while adding prefix support. */
function resolveOrPassThrough(harnessHome: string, idOrPrefix: string): string {
  const ids = listJobs(harnessHome).map((j) => j.id);
  const match = matchJobIdPrefix(ids, idOrPrefix);
  if (match.kind === 'ambiguous') throw ambiguousPrefixError(idOrPrefix, match.matches);
  return match.kind === 'resolved' ? match.id : idOrPrefix;
}

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
  return getJob(harnessHome, resolveOrPassThrough(harnessHome, id));
}

export function runCronPause(harnessHome: string, id: string): Job | undefined {
  return pauseJob(harnessHome, resolveOrPassThrough(harnessHome, id));
}

export function runCronResume(harnessHome: string, id: string): Job | undefined {
  return resumeJob(harnessHome, resolveOrPassThrough(harnessHome, id));
}

export function runCronDelete(harnessHome: string, id: string): boolean {
  return deleteJob(harnessHome, resolveOrPassThrough(harnessHome, id));
}

export function formatJobLine(job: Job): string {
  const status = job.enabled ? 'enabled' : 'paused';
  const next = job.nextRunAt ? new Date(job.nextRunAt).toISOString() : 'never';
  return `${job.id.slice(0, 8)}  ${status.padEnd(8)} next=${next}  prompt=${JSON.stringify(job.prompt.slice(0, 40))}`;
}
