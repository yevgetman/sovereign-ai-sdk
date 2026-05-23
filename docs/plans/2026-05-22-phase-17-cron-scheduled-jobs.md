# Phase 17 — Cron / scheduled jobs · Implementation Plan

**Goal:** scheduled agent runs in fresh sessions, delivered to any channel, with skill chaining and optional pre-agent scripts.

**Architecture:** Embed a 60-second tick loop in `buildRuntime`'s lifecycle (no separate daemon). Each tick scans `<harnessHome>/cron/jobs.json` (atomic temp+rename writes), filters to due jobs, and spawns each as a fresh session through `AgentRunner` with auto-deny on permission asks (matching `sov drive` headless mode). Hermes-style — short-lived fire-and-forget runs, not stateful missions.

**Tech Stack:** TypeScript (Bun runtime); `cron-parser@^4.9.0` for 5-field cron expressions; existing `Runtime` / `AgentRunner` / `expandSkillPrompt` / `buildCanUseTool` / `send` modules.

---

## Locked design decisions

| Decision | Choice |
|---|---|
| **Q1 permission policy** | Auto-deny `ask` fall-through (matches `sov drive` headless mode). No bypass flag in v0. |
| **Q2 delivered output** | Final assistant text message; on failure, terminal reason + error. Full transcript always written to outbox file regardless. |
| **Q3 skill body injection** | User-message body via existing `expandSkillPrompt` (matches harness convention; deviates from spec's "system prompt" phrasing which predates M8). |
| **Q4 CLI verb** | `sov cron add` (matches spec). Tool name `cron_add`. Rename exclusions placeholder `cron_create` → `cron_add`. |
| **Q5 script root** | Absolute paths allowed; relative paths resolve under `<harnessHome>/cron/scripts/`. No sandbox in v0 (trust boundary matches `sov init`). |

## What's intentionally out of scope

- Standalone long-running cron daemon (embedded in runtime lifecycle only).
- Webhook-triggered jobs.
- Per-job model override.
- TUI surface for cron management (CLI only in v0).
- `DeliveryRouter` registry/adapter pattern (single switch arm in `send`).
- Per-job `allowedTools` scoping (cron-wide exclusion set only).
- Retry-on-failure with backoff.
- Concurrent execution within a single tick (sequential).
- Cleanup sweep for old cron sessions (defer).

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | `cron-parser` unmaintained | Pin to `^4.9.0`; in-house 50-line fallback if forced. |
| R2 | Tick loop only fires while `sov` runs | Documented in README + `sov cron list` ("only fires if sov is running"). Long-running terminal pane is the v0 deployment pattern. |
| R3 | Session DB bloat from per-run sessions | Sessions tagged `metadata.kind='cron'`; cleanup deferred to follow-up. |
| R4 | `[SILENT]` only inspects first line | Documented narrow contract — literal first 8 chars after trimming leading whitespace. |
| R5 | Scripts run with full env credentials | Documented; same trust boundary as bundle code. |

---

## File structure

**Create:**
- `src/cron/types.ts` — `ScheduleKind`, `Job`, `CronRunResult` types.
- `src/cron/schedule.ts` — `parseSchedule`, `computeNextRun` (pure functions).
- `src/cron/jobs.ts` — `addJob`, `listJobs`, `getJob`, `pauseJob`, `resumeJob`, `deleteJob`, `recordJobRun`; atomic temp+rename persistence to `<harnessHome>/cron/jobs.json`.
- `src/cron/runner.ts` — `CronRunner` class; tick loop; file-lock; per-job AgentRunner dispatch.
- `src/cli/cronCommand.ts` — Commander subcommand handlers.
- `tests/cron/schedule.test.ts`, `tests/cron/jobs.test.ts`, `tests/cron/runner.test.ts`, `tests/cron/runner.skills.test.ts`, `tests/cron/runner.script.test.ts`, `tests/cron/runner.permissions.test.ts`, `tests/cron/smoke.test.ts`, `tests/cli/cronCommand.test.ts`.
- `docs/state/2026-05-22-phase-17-cron.md` — close-out snapshot.

**Modify:**
- `package.json` — add `cron-parser@^4.9.0` to `dependencies`.
- `src/agents/exclusions.ts` — rename `cron_create`/`cron_list`/`cron_delete` to `cron_add`/`cron_list`/`cron_show`/`cron_pause`/`cron_resume`/`cron_delete`.
- `src/channels/delivery.ts` — add cron-outbox path (`<harnessHome>/cron/outbox/<jobId>/<ts>.txt`) + `[SILENT]` prefix detection.
- `src/server/runtime.ts` — wire `CronRunner` into `buildRuntime`; new `cronEnabled` option (default true); add `cronRunner` field to `Runtime`; dispose order.
- `src/main.ts` — register `sov cron` parent command + 8 subcommands (mirrors `learning` pattern at line 470).
- `docs/testing-log.md` — append entry per testing pass.
- `CLAUDE.md` + `AGENTS.md` (byte-identical) — index pointer to cron docs.

---

## T1 — Schedule parsing (~45 min)

**Files:**
- Create: `src/cron/types.ts`, `src/cron/schedule.ts`, `tests/cron/schedule.test.ts`.
- Modify: `package.json`.

- [ ] **Step 1** — Add `cron-parser` to `package.json` deps and install.

```bash
bun add cron-parser@^4.9.0
```

- [ ] **Step 2** — Define `ScheduleKind` in `src/cron/types.ts`.

```typescript
export type ScheduleKind =
  | { kind: 'relative'; offsetMs: number }
  | { kind: 'interval'; intervalMs: number }
  | { kind: 'cron'; expression: string }
  | { kind: 'iso'; runAt: number };
```

- [ ] **Step 3** — Write failing tests in `tests/cron/schedule.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { computeNextRun, parseSchedule } from '../../src/cron/schedule.js';

describe('parseSchedule', () => {
  test('parses relative duration "30m"', () => {
    expect(parseSchedule('30m')).toEqual({ kind: 'relative', offsetMs: 30 * 60_000 });
  });
  test('parses relative duration "2h"', () => {
    expect(parseSchedule('2h')).toEqual({ kind: 'relative', offsetMs: 2 * 3_600_000 });
  });
  test('parses relative duration "1d"', () => {
    expect(parseSchedule('1d')).toEqual({ kind: 'relative', offsetMs: 86_400_000 });
  });
  test('parses interval "every 2h"', () => {
    expect(parseSchedule('every 2h')).toEqual({ kind: 'interval', intervalMs: 2 * 3_600_000 });
  });
  test('parses cron expression "0 9 * * *"', () => {
    expect(parseSchedule('0 9 * * *')).toEqual({ kind: 'cron', expression: '0 9 * * *' });
  });
  test('parses ISO timestamp', () => {
    const iso = '2026-05-22T17:00:00Z';
    expect(parseSchedule(iso)).toEqual({ kind: 'iso', runAt: Date.parse(iso) });
  });
  test('throws on empty input', () => {
    expect(() => parseSchedule('')).toThrow();
  });
  test('throws on unparseable input', () => {
    expect(() => parseSchedule('flibberty')).toThrow();
  });
});

describe('computeNextRun', () => {
  const now = Date.parse('2026-05-22T12:00:00Z');
  test('relative: returns now + offset on first run', () => {
    const sched = { kind: 'relative' as const, offsetMs: 30 * 60_000 };
    expect(computeNextRun(sched, null, now)).toBe(now + 30 * 60_000);
  });
  test('relative: returns null after first run (one-shot)', () => {
    const sched = { kind: 'relative' as const, offsetMs: 30 * 60_000 };
    expect(computeNextRun(sched, now, now + 60_000)).toBeNull();
  });
  test('interval: returns lastRun + intervalMs', () => {
    const sched = { kind: 'interval' as const, intervalMs: 60_000 };
    expect(computeNextRun(sched, now, now + 30_000)).toBe(now + 60_000);
  });
  test('cron: returns next fire after now', () => {
    const sched = { kind: 'cron' as const, expression: '0 9 * * *' };
    const result = computeNextRun(sched, null, now);
    expect(result).toBe(Date.parse('2026-05-23T09:00:00Z'));
  });
  test('iso: returns runAt on first run', () => {
    const target = Date.parse('2026-05-22T17:00:00Z');
    const sched = { kind: 'iso' as const, runAt: target };
    expect(computeNextRun(sched, null, now)).toBe(target);
  });
  test('iso: returns null after first run', () => {
    const target = Date.parse('2026-05-22T17:00:00Z');
    const sched = { kind: 'iso' as const, runAt: target };
    expect(computeNextRun(sched, target, target + 60_000)).toBeNull();
  });
});
```

Run: `bun test tests/cron/schedule.test.ts` — expect ALL fail (module missing).

- [ ] **Step 4** — Implement `src/cron/schedule.ts`:

```typescript
import cronParser from 'cron-parser';
import type { ScheduleKind } from './types.js';

const RELATIVE_RE = /^(\d+)([smhd])$/;
const INTERVAL_RE = /^every\s+(\d+)([smhd])$/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseSchedule(spec: string): ScheduleKind {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error('schedule cannot be empty');

  const interval = INTERVAL_RE.exec(trimmed);
  if (interval) {
    const [, n, unit] = interval;
    return { kind: 'interval', intervalMs: Number(n) * UNIT_MS[unit] };
  }

  const relative = RELATIVE_RE.exec(trimmed);
  if (relative) {
    const [, n, unit] = relative;
    return { kind: 'relative', offsetMs: Number(n) * UNIT_MS[unit] };
  }

  const isoTs = Date.parse(trimmed);
  if (!Number.isNaN(isoTs) && /^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return { kind: 'iso', runAt: isoTs };
  }

  try {
    cronParser.parseExpression(trimmed);
    return { kind: 'cron', expression: trimmed };
  } catch (err) {
    throw new Error(`unparseable schedule: ${spec}`);
  }
}

export function computeNextRun(
  schedule: ScheduleKind,
  lastRun: number | null,
  now: number,
): number | null {
  switch (schedule.kind) {
    case 'relative':
      return lastRun === null ? now + schedule.offsetMs : null;
    case 'iso':
      return lastRun === null ? schedule.runAt : null;
    case 'interval':
      return (lastRun ?? now) + schedule.intervalMs;
    case 'cron': {
      const baseTime = lastRun ?? now - 1;
      const it = cronParser.parseExpression(schedule.expression, { currentDate: new Date(baseTime) });
      return it.next().getTime();
    }
  }
}
```

Run: `bun test tests/cron/schedule.test.ts` — expect ALL pass.

- [ ] **Step 5** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add package.json bun.lockb src/cron/types.ts src/cron/schedule.ts tests/cron/schedule.test.ts
git commit -m "feat(cron): schedule parser supporting relative / interval / cron / ISO"
```

---

## T2 — Job record + atomic CRUD (~60 min)

**Files:** Create `src/cron/jobs.ts`, `tests/cron/jobs.test.ts`.

- [ ] **Step 1** — Add `Job` type to `src/cron/types.ts`:

```typescript
export type Job = {
  id: string;
  prompt: string;
  schedule: ScheduleKind;
  deliver: string;
  skills: string[];
  script?: string;
  scriptTimeoutMs?: number;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt?: number;
  lastResult?: { ok: boolean; deliveryOk?: boolean; error?: string; durationMs: number };
  createdAt: number;
  updatedAt: number;
};

export type JobsFile = {
  version: 1;
  jobs: Job[];
};
```

- [ ] **Step 2** — Failing tests in `tests/cron/jobs.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addJob, deleteJob, getJob, listJobs, loadJobs,
  pauseJob, resumeJob,
} from '../../src/cron/jobs.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cron-jobs-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('jobs CRUD', () => {
  test('loadJobs returns empty list when file missing', () => {
    expect(loadJobs(home)).toEqual([]);
  });
  test('addJob persists job to jobs.json', () => {
    const job = addJob(home, {
      prompt: 'hi', schedule: { kind: 'relative', offsetMs: 60_000 },
      deliver: 'local', skills: [],
    });
    expect(job.id).toBeTruthy();
    expect(loadJobs(home)).toHaveLength(1);
  });
  test('listJobs returns all jobs', () => {
    addJob(home, { prompt: 'a', schedule: { kind: 'relative', offsetMs: 60_000 }, deliver: 'local', skills: [] });
    addJob(home, { prompt: 'b', schedule: { kind: 'relative', offsetMs: 60_000 }, deliver: 'local', skills: [] });
    expect(listJobs(home)).toHaveLength(2);
  });
  test('getJob returns specific job by id', () => {
    const j = addJob(home, { prompt: 'a', schedule: { kind: 'relative', offsetMs: 60_000 }, deliver: 'local', skills: [] });
    expect(getJob(home, j.id)?.prompt).toBe('a');
  });
  test('pauseJob and resumeJob flip enabled flag', () => {
    const j = addJob(home, { prompt: 'a', schedule: { kind: 'relative', offsetMs: 60_000 }, deliver: 'local', skills: [] });
    expect(pauseJob(home, j.id)?.enabled).toBe(false);
    expect(resumeJob(home, j.id)?.enabled).toBe(true);
  });
  test('deleteJob removes the job', () => {
    const j = addJob(home, { prompt: 'a', schedule: { kind: 'relative', offsetMs: 60_000 }, deliver: 'local', skills: [] });
    expect(deleteJob(home, j.id)).toBe(true);
    expect(loadJobs(home)).toHaveLength(0);
  });
  test('writes use atomic temp+rename', () => {
    addJob(home, { prompt: 'a', schedule: { kind: 'relative', offsetMs: 60_000 }, deliver: 'local', skills: [] });
    // The .tmp sibling should not exist after a normal write.
    const fs = require('node:fs');
    const files = fs.readdirSync(join(home, 'cron'));
    expect(files).toContain('jobs.json');
    expect(files.some((f: string) => f.endsWith('.tmp'))).toBe(false);
  });
});
```

Run: expect ALL fail (module missing).

- [ ] **Step 3** — Implement `src/cron/jobs.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  jobs[idx] = { ...fn(jobs[idx]), updatedAt: Date.now() };
  saveJobs(home, jobs);
  return jobs[idx];
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
```

Run: expect ALL pass.

- [ ] **Step 4** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add src/cron/types.ts src/cron/jobs.ts tests/cron/jobs.test.ts
git commit -m "feat(cron): Job record + atomic jobs.json CRUD"
```

---

## T3 — Recursion guard: rename cron exclusion placeholders (~20 min)

**Files:** Modify `src/agents/exclusions.ts`. Update any test that snapshots the set.

- [ ] **Step 1** — Read current exclusion set:

```bash
grep -n "cron_" src/agents/exclusions.ts
```

- [ ] **Step 2** — Find existing tests that pin the set:

```bash
grep -rn "SUBAGENT_EXCLUDED_TOOLS\|cron_create\|cron_list\|cron_delete" tests/ src/
```

- [ ] **Step 3** — Edit `src/agents/exclusions.ts`. Replace `cron_create` → `cron_add`. Add `cron_show`, `cron_pause`, `cron_resume`. Keep `cron_list` and `cron_delete`. The exclusion set should contain: `cron_add`, `cron_list`, `cron_show`, `cron_pause`, `cron_resume`, `cron_delete`.

- [ ] **Step 4** — If any test fixtures hard-code `cron_create`, update to `cron_add`.

- [ ] **Step 5** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add src/agents/exclusions.ts tests/agents/exclusions.test.ts
git commit -m "chore(agents): align cron tool names in subagent exclusion set"
```

---

## T4 — Delivery: cron-outbox path + `[SILENT]` prefix (~45 min)

**Files:** Modify `src/channels/delivery.ts`, `tests/channels/delivery.test.ts` (create if absent).

- [ ] **Step 1** — Failing tests in `tests/channels/delivery.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send } from '../../src/channels/delivery.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'delivery-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('send local', () => {
  test('writes to outbox/local for free-form local delivery', async () => {
    const res = await send('local', 'hello', home);
    expect(res.ok).toBe(true);
    const files = readdirSync(join(home, 'outbox', 'local'));
    expect(files.length).toBe(1);
    expect(readFileSync(join(home, 'outbox', 'local', files[0]), 'utf8')).toBe('hello');
  });
  test('writes to cron-outbox when cronJobId provided', async () => {
    const res = await send('local', 'hello', home, { cronJobId: 'job-abc' });
    expect(res.ok).toBe(true);
    const files = readdirSync(join(home, 'cron', 'outbox', 'job-abc'));
    expect(files.length).toBe(1);
  });
});

describe('send [SILENT] prefix', () => {
  test('returns silent:true and skips write when [SILENT] prefix present', async () => {
    const res = await send('local', '[SILENT] hello', home);
    expect(res.ok).toBe(true);
    expect(res.silent).toBe(true);
    // No file written.
    const fs = require('node:fs');
    expect(fs.existsSync(join(home, 'outbox', 'local'))).toBe(false);
  });
  test('case-insensitive prefix match', async () => {
    const res = await send('local', '[silent] hello', home);
    expect(res.silent).toBe(true);
  });
  test('trims leading whitespace before checking', async () => {
    const res = await send('local', '  [SILENT] hello', home);
    expect(res.silent).toBe(true);
  });
});
```

Run: expect fails because (a) `cronJobId` option not supported, (b) `silent` field not on result.

- [ ] **Step 2** — Update `src/channels/types.ts` (or wherever `DeliveryResult` lives) to add `silent?: boolean` to the result type.

```bash
grep -n "DeliveryResult" src/channels/types.ts src/channels/*.ts
```

Edit the type:

```typescript
export type DeliveryResult = {
  ok: boolean;
  error?: string;
  silent?: boolean;
};
```

- [ ] **Step 3** — Update `src/channels/delivery.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import type { DeliveryResult } from './types.js';

const SILENT_PREFIX = '[silent]';

export type SendOptions = {
  cronJobId?: string;
};

export async function send(
  target: string,
  content: string,
  harnessHome: string = resolveHarnessHome(),
  options: SendOptions = {},
): Promise<DeliveryResult> {
  // [SILENT] prefix: short-circuit before any delivery.
  const trimmed = content.trimStart();
  if (trimmed.toLowerCase().startsWith(SILENT_PREFIX)) {
    return { ok: true, silent: true };
  }

  if (target !== 'local') {
    return { ok: false, error: `unknown delivery target: ${target}` };
  }

  try {
    const outboxDir = options.cronJobId
      ? join(harnessHome, 'cron', 'outbox', options.cronJobId)
      : join(harnessHome, 'outbox', 'local');
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, `${Date.now()}.txt`), content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Run: expect ALL pass.

- [ ] **Step 4** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add src/channels/delivery.ts src/channels/types.ts tests/channels/delivery.test.ts
git commit -m "feat(channels): cron-outbox path + [SILENT] prefix detection"
```

---

## T5 — CronRunner with injectable clock + file-lock (~75 min)

**Files:** Create `src/cron/runner.ts`, `tests/cron/runner.test.ts`.

- [ ] **Step 1** — Failing tests in `tests/cron/runner.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addJob } from '../../src/cron/jobs.js';
import { CronRunner } from '../../src/cron/runner.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cron-runner-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

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
      runJob: async (j) => { runs.push(j.id); return { ok: true, durationMs: 1 }; },
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
      runJob: async (job) => { runs.push(job.id); return { ok: true, durationMs: 1 }; },
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
    const r1 = new CronRunner({ harnessHome: home, now: () => 0, runJob: async () => ({ ok: true, durationMs: 1 }) });
    const r2 = new CronRunner({ harnessHome: home, now: () => 0, runJob: async () => ({ ok: true, durationMs: 1 }) });
    expect(r1.tryAcquireTickLock()).toBe(true);
    expect(r2.tryAcquireTickLock()).toBe(false);
    r1.releaseTickLock();
    expect(r2.tryAcquireTickLock()).toBe(true);
    r2.releaseTickLock();
  });
});
```

Run: expect ALL fail.

- [ ] **Step 2** — Implement `src/cron/runner.ts`:

```typescript
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getJob, listJobs, recordJobRun } from './jobs.js';
import type { Job } from './types.js';

export type CronRunResult = {
  ok: boolean;
  output?: string;
  error?: string;
  deliveryOk?: boolean;
  durationMs: number;
};

export type CronRunnerOptions = {
  harnessHome: string;
  now: () => number;
  runJob: (job: Job) => Promise<CronRunResult>;
  tickIntervalMs?: number;
};

export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lockHeld = false;

  constructor(private readonly opts: CronRunnerOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.tickIntervalMs ?? 60_000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.releaseTickLock();
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    if (!this.tryAcquireTickLock()) return;
    this.inFlight = true;
    try {
      await this.runDueJobs();
    } finally {
      this.inFlight = false;
      this.releaseTickLock();
    }
  }

  async runDueJobs(): Promise<void> {
    const now = this.opts.now();
    const jobs = listJobs(this.opts.harnessHome);
    const due = jobs.filter((j) => j.enabled && j.nextRunAt !== null && j.nextRunAt <= now);
    for (const job of due) {
      const ranAt = this.opts.now();
      let result: CronRunResult;
      try {
        result = await this.opts.runJob(job);
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: this.opts.now() - ranAt,
        };
      }
      recordJobRun(this.opts.harnessHome, job.id, ranAt, {
        ok: result.ok,
        ...(result.deliveryOk !== undefined ? { deliveryOk: result.deliveryOk } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        durationMs: result.durationMs,
      });
    }
  }

  tryAcquireTickLock(): boolean {
    const lockDir = join(this.opts.harnessHome, 'cron', '.tick.lock');
    mkdirSync(join(this.opts.harnessHome, 'cron'), { recursive: true });
    try {
      mkdirSync(lockDir);
      this.lockHeld = true;
      return true;
    } catch {
      return false;
    }
  }

  releaseTickLock(): void {
    if (!this.lockHeld) return;
    const lockDir = join(this.opts.harnessHome, 'cron', '.tick.lock');
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* swallow */ }
    this.lockHeld = false;
  }
}
```

Run: expect ALL pass.

- [ ] **Step 3** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add src/cron/runner.ts tests/cron/runner.test.ts
git commit -m "feat(cron): CronRunner with file-lock + due-job dispatch"
```

---

## T6 — Wire cron job execution: build `runCronJob` against AgentRunner + delivery (~90 min)

**Files:** Create `src/cron/execute.ts`, `tests/cron/execute.test.ts`.

- [ ] **Step 1** — Failing test in `tests/cron/execute.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCronJobExecutor } from '../../src/cron/execute.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cron-execute-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('cron executor', () => {
  test('runs a simple job through the injected agent and writes to outbox', async () => {
    const calls: string[] = [];
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return { ok: true, output: 'final assistant text' };
      },
      expandSkills: async () => '',
      runScript: async () => '',
    });
    const result = await execute({
      id: 'job-1', prompt: 'say hi', schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local', skills: [], enabled: true, nextRunAt: 0,
      createdAt: 0, updatedAt: 0,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['say hi']);
    const outboxFiles = readdirSync(join(home, 'cron', 'outbox', 'job-1'));
    expect(outboxFiles).toHaveLength(1);
  });

  test('prepends skill bodies and script output to prompt', async () => {
    let captured = '';
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async ({ prompt }) => {
        captured = prompt;
        return { ok: true, output: 'ok' };
      },
      expandSkills: async (skills) => skills.map((s) => `<skill:${s}>`).join('\n\n---\n\n'),
      runScript: async () => 'script output\nline2',
    });
    await execute({
      id: 'job-1', prompt: 'operator prompt',
      schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local', skills: ['s1', 's2'], script: 'pre.sh',
      enabled: true, nextRunAt: 0, createdAt: 0, updatedAt: 0,
    });
    expect(captured).toContain('## Script output');
    expect(captured).toContain('script output');
    expect(captured).toContain('<skill:s1>');
    expect(captured).toContain('<skill:s2>');
    expect(captured).toContain('operator prompt');
  });

  test('[SILENT] output is recorded but not delivered', async () => {
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async () => ({ ok: true, output: '[SILENT] internal note' }),
      expandSkills: async () => '',
      runScript: async () => '',
    });
    const result = await execute({
      id: 'job-1', prompt: 'p', schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local', skills: [], enabled: true, nextRunAt: 0,
      createdAt: 0, updatedAt: 0,
    });
    expect(result.ok).toBe(true);
    // No outbox file when silent.
    const fs = require('node:fs');
    expect(fs.existsSync(join(home, 'cron', 'outbox', 'job-1'))).toBe(false);
  });

  test('script timeout records failure', async () => {
    const execute = buildCronJobExecutor({
      harnessHome: home,
      runAgent: async () => ({ ok: true, output: 'ok' }),
      expandSkills: async () => '',
      runScript: async () => { throw new Error('script timed out'); },
    });
    const result = await execute({
      id: 'job-1', prompt: 'p', schedule: { kind: 'relative', offsetMs: 0 },
      deliver: 'local', skills: [], script: 'slow.sh',
      enabled: true, nextRunAt: 0, createdAt: 0, updatedAt: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('script');
  });
});
```

Run: expect ALL fail.

- [ ] **Step 2** — Implement `src/cron/execute.ts`:

```typescript
import { send } from '../channels/delivery.js';
import type { CronRunResult } from './runner.js';
import type { Job } from './types.js';

export type AgentRunInput = {
  prompt: string;
  cronJobId: string;
};

export type AgentRunOutput = {
  ok: boolean;
  output?: string;
  error?: string;
};

export type CronExecutorDeps = {
  harnessHome: string;
  runAgent: (input: AgentRunInput) => Promise<AgentRunOutput>;
  expandSkills: (skills: string[], cwd: string) => Promise<string>;
  runScript: (scriptPath: string, cwd: string, timeoutMs: number) => Promise<string>;
  cwd?: string;
};

const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;

export function buildCronJobExecutor(deps: CronExecutorDeps) {
  return async function executeCronJob(job: Job): Promise<CronRunResult> {
    const started = Date.now();
    const cwd = deps.cwd ?? deps.harnessHome;
    try {
      let scriptOutput = '';
      if (job.script) {
        try {
          scriptOutput = await deps.runScript(
            job.script,
            cwd,
            job.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
          );
        } catch (err) {
          return {
            ok: false,
            error: `pre-agent script failed: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - started,
          };
        }
      }

      const skillBlock = job.skills.length > 0
        ? await deps.expandSkills(job.skills, cwd)
        : '';

      const sections: string[] = [];
      if (scriptOutput) sections.push(`## Script output\n\n${scriptOutput}`);
      if (skillBlock) sections.push(skillBlock);
      sections.push(job.prompt);
      const prompt = sections.join('\n\n---\n\n');

      const agentResult = await deps.runAgent({ prompt, cronJobId: job.id });
      const output = agentResult.output ?? '';

      const delivery = await send(job.deliver, output, deps.harnessHome, {
        cronJobId: job.id,
      });

      return {
        ok: agentResult.ok,
        ...(output !== '' ? { output } : {}),
        ...(agentResult.error !== undefined ? { error: agentResult.error } : {}),
        deliveryOk: delivery.ok,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  };
}
```

Run: expect ALL pass.

- [ ] **Step 3** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add src/cron/execute.ts tests/cron/execute.test.ts
git commit -m "feat(cron): job executor — script + skills + AgentRunner + delivery"
```

---

## T7 — Wire CronRunner into buildRuntime (~75 min)

**Files:** Modify `src/server/runtime.ts`; create `src/cron/wiring.ts` (production glue); add `tests/cron/wiring.test.ts`.

- [ ] **Step 1** — Read `src/server/runtime.ts` for the `RuntimeOptions` type, the `Runtime` shape, and the `dispose()` flow. Identify where to construct + dispose the runner.

- [ ] **Step 2** — Create `src/cron/wiring.ts`:

```typescript
import { spawnSync } from 'node:child_process';
import { join, isAbsolute, resolve } from 'node:path';
import { expandSkillPrompt } from '../skills/loader.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import type { Runtime } from '../server/runtime.js';
import { buildCronJobExecutor } from './execute.js';
import { CronRunner } from './runner.js';
import type { CronRunResult } from './runner.js';
import type { Job } from './types.js';

const MAX_SCRIPT_STDOUT = 16 * 1024;

function resolveScriptPath(harnessHome: string, scriptPath: string): string {
  return isAbsolute(scriptPath)
    ? scriptPath
    : resolve(join(harnessHome, 'cron', 'scripts', scriptPath));
}

function inferInterpreter(scriptPath: string): string[] {
  if (scriptPath.endsWith('.py')) return ['python3', scriptPath];
  if (scriptPath.endsWith('.ts') || scriptPath.endsWith('.js')) return ['bun', scriptPath];
  if (scriptPath.endsWith('.sh')) return ['bash', scriptPath];
  return [scriptPath];
}

export function createProductionCronRunner(runtime: Runtime, harnessHome: string): CronRunner {
  const executor = buildCronJobExecutor({
    harnessHome,
    cwd: runtime.cwd,
    runAgent: async ({ prompt, cronJobId }) => {
      // Build a fresh-session AgentRunner-equivalent invocation.
      // Construct a session, then call the runtime's agent loop directly.
      // The implementation route depends on the current `AgentRunner` shape;
      // see Task 7 step 4 for the concrete wiring.
      throw new Error('runAgent: implement in step 4');
    },
    expandSkills: async (skills, cwd) => {
      const expansions: string[] = [];
      for (const name of skills) {
        const skill = runtime.skills.byName.get(name);
        if (!skill) throw new Error(`unknown skill: ${name}`);
        const expanded = await expandSkillPrompt(skill, {
          args: '',
          cwd,
          sessionId: 'cron',
        });
        expansions.push(expanded);
      }
      return expansions.join('\n\n---\n\n');
    },
    runScript: async (scriptPath, cwd, timeoutMs) => {
      const resolved = resolveScriptPath(harnessHome, scriptPath);
      const argv = inferInterpreter(resolved);
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd,
        timeout: timeoutMs,
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`exited ${result.status}: ${result.stderr?.slice(0, 1024)}`);
      }
      return (result.stdout ?? '').slice(0, MAX_SCRIPT_STDOUT);
    },
  });

  return new CronRunner({
    harnessHome,
    now: () => Date.now(),
    runJob: (job: Job): Promise<CronRunResult> => executor(job),
  });
}
```

- [ ] **Step 3** — Modify `src/server/runtime.ts`:

(a) Extend `RuntimeOptions`:

```typescript
export type RuntimeOptions = {
  // ... existing fields ...
  cronEnabled?: boolean;
};
```

(b) Extend `Runtime`:

```typescript
export type Runtime = {
  // ... existing fields ...
  cronRunner?: CronRunner;
};
```

(c) After `buildRuntime` finishes its existing construction (just before the `return` of the runtime object), construct + start the cron runner when `opts.cronEnabled !== false`:

```typescript
import { createProductionCronRunner } from '../cron/wiring.js';

// ...inside buildRuntime, near the end of the function...
let cronRunner: CronRunner | undefined;
if (opts.cronEnabled !== false) {
  cronRunner = createProductionCronRunner(runtime, harnessHome);
  cronRunner.start();
  runtime.cronRunner = cronRunner;
}
```

(d) In `dispose()`, stop the runner first:

```typescript
const dispose = async (): Promise<void> => {
  cronRunner?.stop();
  // ... existing dispose logic ...
};
```

- [ ] **Step 4** — Implement the `runAgent` glue in `src/cron/wiring.ts`. Build the smallest possible adapter that uses the runtime's session DB to create a fresh session, runs the `query` loop with cron-specific tools, and returns the final assistant text:

```typescript
// Inside createProductionCronRunner, replace the throwing runAgent stub:
runAgent: async ({ prompt, cronJobId }) => {
  const session = runtime.sessionDb.createSession({
    metadata: { kind: 'cron', cronJobId },
  });
  try {
    const ctx = await runtime.getSessionContext(session.id);
    const canUseTool = buildCanUseTool({
      mode: 'default',
      ask: async () => ({ behavior: 'deny', message: 'cron auto-deny' }),
      ruleLayers: ctx.permissionLayers,
      alwaysAllow: new Set(),
    });
    // Run the agent loop. The exact entry point depends on the runtime
    // shape — typically `runtime.agentRunner.run({ ... })` or equivalent.
    // The implementer reads `src/runtime/agentRunner.ts` to confirm the
    // signature and wires `prompt`, `canUseTool`, the cron-excluded tools,
    // and a sane `maxTurns` (default 10).
    const result = await runtime.agentRunner.run({
      sessionId: session.id,
      input: prompt,
      canUseTool,
      maxTurns: 10,
      toolFilter: (t) => !CRON_EXCLUDED.has(t.name),
    });
    return {
      ok: result.terminal.kind === 'completed',
      output: result.finalAssistantText ?? '',
      ...(result.terminal.kind !== 'completed'
        ? { error: result.terminal.reason ?? 'unknown' }
        : {}),
    };
  } finally {
    await runtime.disposeSession(session.id);
  }
},
```

**Implementer note:** the exact `AgentRunner` API is in `src/runtime/agentRunner.ts`. Read it before implementing this step. The fields above (`agentRunner.run`, `result.terminal.kind`, `result.finalAssistantText`, `toolFilter`) are placeholders — substitute the real ones. Do NOT invent shapes; if the real API takes a different form (e.g., returns events via callback), adapt the wiring to match without changing the executor's `runAgent` contract.

If `AgentRunner.run` doesn't exist as a single-call API, build the wiring inside `src/cron/wiring.ts` from the lower-level `query` generator — capture the final assistant message by accumulating `text_delta` events on the last assistant content block until `turn_complete` fires.

- [ ] **Step 5** — Integration test in `tests/cron/wiring.test.ts`. Use a mock provider that returns a fixed assistant turn; assert end-to-end that adding a job + advancing the clock fires the agent + writes to the cron outbox.

- [ ] **Step 6** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add src/cron/wiring.ts src/server/runtime.ts tests/cron/wiring.test.ts
git commit -m "feat(cron): wire CronRunner into buildRuntime lifecycle"
```

---

## T8 — CLI surface: `sov cron add | list | show | pause | resume | delete | run | tick` (~90 min)

**Files:** Create `src/cli/cronCommand.ts`; modify `src/main.ts`; create `tests/cli/cronCommand.test.ts`.

- [ ] **Step 1** — Failing tests in `tests/cli/cronCommand.test.ts` for each subcommand against a temp harness home (use `HARNESS_HOME` env override + direct function calls, not subprocess spawning).

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCronAdd, runCronDelete, runCronList,
  runCronPause, runCronResume, runCronShow,
} from '../../src/cli/cronCommand.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cron-cli-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test('add then list shows the job', () => {
  const added = runCronAdd(home, {
    schedule: 'every 1m',
    prompt: 'echo hi',
    deliver: 'local',
    skills: [],
  });
  expect(added.id).toBeTruthy();
  expect(runCronList(home)).toHaveLength(1);
});

test('show returns job detail by id', () => {
  const added = runCronAdd(home, { schedule: 'every 1m', prompt: 'x', deliver: 'local', skills: [] });
  expect(runCronShow(home, added.id)?.prompt).toBe('x');
});

test('pause and resume flip enabled', () => {
  const added = runCronAdd(home, { schedule: 'every 1m', prompt: 'x', deliver: 'local', skills: [] });
  expect(runCronPause(home, added.id)?.enabled).toBe(false);
  expect(runCronResume(home, added.id)?.enabled).toBe(true);
});

test('delete removes the job', () => {
  const added = runCronAdd(home, { schedule: 'every 1m', prompt: 'x', deliver: 'local', skills: [] });
  expect(runCronDelete(home, added.id)).toBe(true);
  expect(runCronList(home)).toHaveLength(0);
});

test('add rejects unknown schedule', () => {
  expect(() => runCronAdd(home, { schedule: 'gibberish', prompt: 'x', deliver: 'local', skills: [] })).toThrow();
});
```

Run: expect ALL fail.

- [ ] **Step 2** — Implement `src/cli/cronCommand.ts`:

```typescript
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
```

- [ ] **Step 3** — Wire Commander subcommands in `src/main.ts`. Look at the existing `learning` block (line ~470) for the pattern. Add a parallel `cron` block:

```typescript
const cronCmd = program
  .command('cron')
  .description('manage scheduled jobs');

cronCmd
  .command('add')
  .description('add a new cron job')
  .requiredOption('--schedule <spec>', 'schedule (relative, interval, cron, ISO)')
  .requiredOption('--prompt <text>', 'operator prompt to send')
  .option('--deliver <target>', 'delivery target (local | telegram:... | slack:...)', 'local')
  .option('--skills <names...>', 'skills to chain (in order)')
  .option('--script <path>', 'pre-agent script path')
  .action(async (opts) => {
    const { runCronAdd, formatJobLine } = await import('./cli/cronCommand.js');
    const { resolveHarnessHome } = await import('./config/paths.js');
    const job = runCronAdd(resolveHarnessHome(), {
      schedule: opts.schedule,
      prompt: opts.prompt,
      deliver: opts.deliver,
      skills: opts.skills ?? [],
      ...(opts.script !== undefined ? { script: opts.script } : {}),
    });
    console.log(`added job ${job.id}`);
    console.log(formatJobLine(job));
  });

// ... and list / show / pause / resume / delete / run / tick ...
```

(`run <id>` and `tick` need to boot a runtime — those use `buildRuntime({ cronEnabled: false })`, fetch the job, fire `createProductionCronRunner` once, then call `runner.runDueJobs()` or invoke the executor directly. Implementer details these against the actual `buildRuntime` API.)

- [ ] **Step 4** — Pre-commit gate + commit.

```bash
bun run lint && bun run typecheck && bun run test
git add src/cli/cronCommand.ts src/main.ts tests/cli/cronCommand.test.ts
git commit -m "feat(cli): sov cron add | list | show | pause | resume | delete | run | tick"
```

---

## T9 — Smoke test: the spec's `Check` scenario (~30 min)

**Files:** Create `tests/cron/smoke.test.ts`.

- [ ] **Step 1** — Test the exact spec scenario:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCronAdd } from '../../src/cli/cronCommand.js';
import { CronRunner } from '../../src/cron/runner.js';
import { buildCronJobExecutor } from '../../src/cron/execute.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cron-smoke-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test('spec Check: add every-1m job, first tick runs it, output lands in cron-outbox', async () => {
  const added = runCronAdd(home, {
    schedule: 'every 1m',
    prompt: 'echo hello',
    deliver: 'local',
    skills: [],
  });

  const executor = buildCronJobExecutor({
    harnessHome: home,
    runAgent: async () => ({ ok: true, output: 'hello (model response)' }),
    expandSkills: async () => '',
    runScript: async () => '',
  });

  const runner = new CronRunner({
    harnessHome: home,
    now: () => Date.now() + 60_000 + 1000,
    runJob: executor,
  });
  await runner.runDueJobs();

  const outboxFiles = readdirSync(join(home, 'cron', 'outbox', added.id));
  expect(outboxFiles.length).toBe(1);
});
```

Run: expect PASS.

- [ ] **Step 2** — Append a testing-log entry.

- [ ] **Step 3** — Commit.

```bash
bun run lint && bun run typecheck && bun run test
git add tests/cron/smoke.test.ts docs/testing-log.md
git commit -m "test(cron): spec-check smoke pass — every-1m end-to-end"
```

---

## T10 — Docs: state snapshot + CLAUDE/AGENTS update (~45 min)

**Files:** Create `docs/state/2026-05-22-phase-17-cron.md`; update `CLAUDE.md` + `AGENTS.md` (byte-identical) with a cron pointer; update `docs/testing-log.md`.

- [ ] **Step 1** — Write `docs/state/2026-05-22-phase-17-cron.md` covering: what shipped, architecture decisions, test counts, follow-ups (R1–R5 above), and how to use `sov cron`.

- [ ] **Step 2** — In CLAUDE.md + AGENTS.md (mirror): add a `src/cron/` pointer in the "Source-adjacent" or doc-index section.

- [ ] **Step 3** — Append the final testing-log entry with totals.

- [ ] **Step 4** — Verify byte-identical CLAUDE/AGENTS:

```bash
diff CLAUDE.md AGENTS.md && echo IDENTICAL
```

- [ ] **Step 5** — Commit.

```bash
git add docs/state/2026-05-22-phase-17-cron.md CLAUDE.md AGENTS.md docs/testing-log.md
git commit -m "docs(state): Phase 17 cron close-out snapshot"
```

---

## T11 — Cut release v0.3.0 (~15 min)

Per `docs/conventions/cutting-releases.md` — any session that touches `src/` cuts the next release. This phase introduces a major feature; bump minor to v0.3.0 (not patch).

- [ ] **Step 1** — Bump `package.json` to `0.3.0`.

- [ ] **Step 2** — Commit:

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore(release): bump version 0.2.5 -> 0.3.0

Phase 17 — Cron / scheduled jobs ships:
- sov cron add | list | show | pause | resume | delete | run | tick
- Four schedule formats: relative, interval, cron, ISO
- Fresh-session per run via AgentRunner with auto-deny on permission asks
- Skill chaining + pre-agent script injection (120s default timeout)
- Local delivery to <harnessHome>/cron/outbox/<jobId>/ + [SILENT] prefix
- Tick loop embedded in buildRuntime (60s interval, file-locked)
EOF
)"
```

- [ ] **Step 3** — Push:

```bash
git push origin master
```

- [ ] **Step 4** — Cut the binary:

```bash
unset GH_TOKEN
SOV_RELEASES_PATH=/Users/julie/code/sov-releases bun run release v0.3.0
```

- [ ] **Step 5** — Smoke:

```bash
~/.sov/bin/sov upgrade
~/.sov/bin/sov --version    # expect 0.3.0
~/.sov/bin/sov cron --help  # expect to show subcommands
```

---

## Execution

Use **`superpowers:subagent-driven-development`**: dispatch one Opus subagent per task (T1 → T11), reviewing between tasks. T3, T4 are independent of T1/T2 and can run in parallel if desired; T5 depends on T1+T2; T6 depends on T1+T2+T4; T7 depends on T5+T6; T8 depends on T2; T9 depends on T5+T6+T8; T10 + T11 are wrap-up.
