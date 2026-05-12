# Phase 13.5 — Scheduled-Mission Sub-Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sov chat --agent <name> --state-dir <path>` so the harness can run a scheduled autonomous mission — read prior state from a mission directory, do one bounded turn of work, write state back, and exit — enabling OS-level launchd/cron to invoke it on a timer.

**Architecture:** Mission state lives in a dedicated directory (`mission.md`, `plan.md`, `state.json`, `notes.md`, `wake_log.jsonl`, `.lock/`). A typed loader/writer owns that directory contract; an FSM enforces valid state transitions; prompt-segment builders inject the state into the agent's system prompt. The REPL gains `--agent` (run as a specific agent definition) and `--state-dir` (activate mission lifecycle: lock, load, inject, run once, sentinel-parse, write back, unlock). The ops repo's launchd scripts already exist; they need `harness` to be on PATH (add `harness` bin alias to `package.json`) and `--state-dir` to appear in `sov --help` (they check this).

**Tech Stack:** TypeScript/Bun, `node:fs` for atomic-rename writes and mkdir-lock, existing `src/agents/` loader, existing `src/context/systemPrompt.ts` segment shape, Commander CLI, Bun test runner.

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `src/mission/types.ts` | All mission TypeScript types (MissionFsmState, MissionStateJson, WakeLogEntry, MissionFiles) |
| `src/mission/paths.ts` | Canonical mission-dir path helpers (missionMdPath, statePath, wakeLogPath, lockPath, …) |
| `src/mission/state.ts` | Loader (`loadMissionState`) + writer (`writeMissionState`) + wake-log append (`appendWakeLog`) + lock acquire/release |
| `src/mission/fsm.ts` | FSM: valid states, transition table, `shouldRun()`, `applyTransition()` |
| `src/mission/segments.ts` | `buildMissionSegments(files, opts)` → cacheable + ephemeral `SystemSegment[]` |
| `src/cli/missionInit.ts` | `runMissionInit(opts)` + `formatMissionInitResult(result)` for the `sov mission-init` subcommand |
| `bundle-default/agents/scheduled-mission.md` | Agent definition (frontmatter + mission-contract system prompt body) |
| `tests/mission/state.test.ts` | Unit tests for state loader, writer, wake-log append, lock acquire/release |
| `tests/mission/fsm.test.ts` | Unit tests for FSM transitions, shouldRun, applyTransition |
| `tests/mission/segments.test.ts` | Unit tests for buildMissionSegments |
| `tests/mission/missionInit.test.ts` | Unit tests for runMissionInit scaffolding |
| `tests/agents/loader.supportsMissionState.test.ts` | Unit test for loader parsing supportsMissionState from frontmatter |

### Modified files
| File | What changes |
|---|---|
| `src/agents/types.ts` | Add `supportsMissionState?: boolean` to `AgentDefinition` |
| `src/agents/loader.ts` | Add `supportsMissionState` to `FrontmatterSchema` + propagate to `AgentDefinition` |
| `src/ui/terminalRepl.ts` | Add `agentName?: string; stateDir?: string` to `ReplOpts`; wire mission lifecycle: lock, load, FSM check, segment injection, tool restriction, auto-wake, sentinel parse, wake-log write, unlock |
| `src/main.ts` | Add `--agent` and `--state-dir` flags to `chat` command; add `mission-init` subcommand |
| `package.json` | Add `"harness": "./src/main.ts"` to `"bin"` |

---

## Task 1: Mission types and path helpers

**Files:**
- Create: `src/mission/types.ts`
- Create: `src/mission/paths.ts`
- Test: `tests/mission/state.test.ts` (partial — path helpers only in this task)

- [ ] **Step 1: Write types file**

```typescript
// src/mission/types.ts
// Mission-dir contract types for Phase 13.5 scheduled-mission sub-agents.

export type MissionFsmState = 'planning' | 'active' | 'overtime' | 'complete' | 'abandoned';

export type MissionStateJson = {
  fsmState: MissionFsmState;
  wakeCount: number;
  perWakeTurnBudget: number;
  goal: string;
  createdAt: string;
  updatedAt: string;
};

export type WakeLogEntry = {
  wakeNumber: number;
  timestamp: string;
  fsmStateBefore: MissionFsmState;
  fsmStateAfter: MissionFsmState;
  sentinel?: string;
  durationMs: number;
};

export type MissionFiles = {
  mission: string;
  plan: string;
  notes: string;
  state: MissionStateJson;
  recentWakeLog: WakeLogEntry[];
};
```

- [ ] **Step 2: Write path helpers**

```typescript
// src/mission/paths.ts
// Canonical filesystem layout for a mission directory.

import { join } from 'node:path';

export function missionMdPath(dir: string): string {
  return join(dir, 'mission.md');
}

export function planMdPath(dir: string): string {
  return join(dir, 'plan.md');
}

export function notesMdPath(dir: string): string {
  return join(dir, 'notes.md');
}

export function stateJsonPath(dir: string): string {
  return join(dir, 'state.json');
}

export function wakeLogPath(dir: string): string {
  return join(dir, 'wake_log.jsonl');
}

export function lockPath(dir: string): string {
  return join(dir, '.lock');
}
```

- [ ] **Step 3: Write path tests**

Create `tests/mission/state.test.ts` (will grow across tasks 1–2):

```typescript
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  lockPath,
  missionMdPath,
  notesMdPath,
  planMdPath,
  stateJsonPath,
  wakeLogPath,
} from '../../src/mission/paths.js';

describe('mission paths', () => {
  test('missionMdPath returns correct path', () => {
    expect(missionMdPath('/missions/foo')).toBe('/missions/foo/mission.md');
  });
  test('planMdPath returns correct path', () => {
    expect(planMdPath('/missions/foo')).toBe('/missions/foo/plan.md');
  });
  test('notesMdPath returns correct path', () => {
    expect(notesMdPath('/missions/foo')).toBe('/missions/foo/notes.md');
  });
  test('stateJsonPath returns correct path', () => {
    expect(stateJsonPath('/missions/foo')).toBe('/missions/foo/state.json');
  });
  test('wakeLogPath returns correct path', () => {
    expect(wakeLogPath('/missions/foo')).toBe('/missions/foo/wake_log.jsonl');
  });
  test('lockPath returns correct path', () => {
    expect(lockPath('/missions/foo')).toBe('/missions/foo/.lock');
  });
});
```

- [ ] **Step 4: Run path tests (expect pass)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/state.test.ts
```
Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add src/mission/types.ts src/mission/paths.ts tests/mission/state.test.ts
git commit -m "feat(mission): add types and path helpers for Phase 13.5"
```

---

## Task 2: Mission state loader, writer, and lock

**Files:**
- Create: `src/mission/state.ts`
- Modify: `tests/mission/state.test.ts` (add loader/writer/lock tests)

- [ ] **Step 1: Write the failing tests for state loader and writer**

Append to `tests/mission/state.test.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  acquireLock,
  appendWakeLog,
  loadMissionState,
  releaseLock,
  writeMissionState,
} from '../../src/mission/state.js';
import type { MissionStateJson, WakeLogEntry } from '../../src/mission/types.js';

function makeTestDir(): string {
  const dir = join(tmpdir(), `sov-mission-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const VALID_STATE: MissionStateJson = {
  fsmState: 'planning',
  wakeCount: 0,
  perWakeTurnBudget: 10,
  goal: 'Write a test summary',
  createdAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:00.000Z',
};

describe('loadMissionState', () => {
  test('loads a well-formed mission dir', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test Mission\nDo the thing.');
    writeFileSync(join(dir, 'plan.md'), '## Plan\n1. Step one');
    writeFileSync(join(dir, 'notes.md'), 'I was working on step 1.');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));

    const files = loadMissionState(dir);
    expect(files.mission).toContain('Do the thing');
    expect(files.plan).toContain('Step one');
    expect(files.notes).toContain('step 1');
    expect(files.state.fsmState).toBe('planning');
    expect(files.state.wakeCount).toBe(0);
    expect(files.recentWakeLog).toHaveLength(0);
  });

  test('accepts missing optional files (plan, notes, wake_log)', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Minimal');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));

    const files = loadMissionState(dir);
    expect(files.plan).toBe('');
    expect(files.notes).toBe('');
    expect(files.recentWakeLog).toHaveLength(0);
  });

  test('throws if mission.md is missing', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));
    expect(() => loadMissionState(dir)).toThrow(/mission\.md not found/);
  });

  test('throws if state.json is missing', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    expect(() => loadMissionState(dir)).toThrow(/state\.json not found/);
  });

  test('throws if state.json has invalid fsmState', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...VALID_STATE, fsmState: 'bogus' }));
    expect(() => loadMissionState(dir)).toThrow(/invalid fsmState/);
  });

  test('reads last 5 wake log entries', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));
    const entries: WakeLogEntry[] = Array.from({ length: 7 }, (_, i) => ({
      wakeNumber: i + 1,
      timestamp: '2026-05-11T00:00:00.000Z',
      fsmStateBefore: 'active' as const,
      fsmStateAfter: 'active' as const,
      durationMs: 1000,
    }));
    writeFileSync(join(dir, 'wake_log.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const files = loadMissionState(dir);
    expect(files.recentWakeLog).toHaveLength(5);
    expect(files.recentWakeLog[0]?.wakeNumber).toBe(3);
    expect(files.recentWakeLog[4]?.wakeNumber).toBe(7);
  });
});

describe('writeMissionState', () => {
  test('patches state.json atomically', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));

    writeMissionState(dir, { fsmState: 'active', wakeCount: 1, updatedAt: '2026-05-11T01:00:00.000Z' });
    const files = loadMissionState(dir);
    expect(files.state.fsmState).toBe('active');
    expect(files.state.wakeCount).toBe(1);
    expect(files.state.goal).toBe(VALID_STATE.goal);
  });
});

describe('appendWakeLog', () => {
  test('appends a JSONL entry to wake_log.jsonl', () => {
    const dir = makeTestDir();
    const entry: WakeLogEntry = {
      wakeNumber: 1,
      timestamp: '2026-05-11T00:00:00.000Z',
      fsmStateBefore: 'planning',
      fsmStateAfter: 'active',
      durationMs: 1200,
    };
    appendWakeLog(dir, entry);
    appendWakeLog(dir, { ...entry, wakeNumber: 2 });
    const lines = loadMissionState(
      (() => {
        writeFileSync(join(dir, 'mission.md'), '# x');
        writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));
        return dir;
      })(),
    ).recentWakeLog;
    expect(lines).toHaveLength(2);
    expect(lines[0]?.wakeNumber).toBe(1);
    expect(lines[1]?.wakeNumber).toBe(2);
  });
});

describe('lock', () => {
  test('acquireLock succeeds on first call', () => {
    const dir = makeTestDir();
    expect(acquireLock(dir)).toBe(true);
    releaseLock(dir);
  });

  test('acquireLock returns false when already locked', () => {
    const dir = makeTestDir();
    acquireLock(dir);
    expect(acquireLock(dir)).toBe(false);
    releaseLock(dir);
  });

  test('releaseLock is idempotent', () => {
    const dir = makeTestDir();
    acquireLock(dir);
    releaseLock(dir);
    expect(() => releaseLock(dir)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests (expect fail — module not found)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/state.test.ts
```
Expected: fails with "Cannot find module '../../src/mission/state.js'"

- [ ] **Step 3: Implement state.ts**

```typescript
// src/mission/state.ts
// Mission-dir loader, writer, wake-log append, and overlap lock for Phase 13.5.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { lockPath, missionMdPath, notesMdPath, planMdPath, stateJsonPath, wakeLogPath } from './paths.js';
import type { MissionFiles, MissionFsmState, MissionStateJson, WakeLogEntry } from './types.js';

const VALID_FSM_STATES = new Set<string>(['planning', 'active', 'overtime', 'complete', 'abandoned']);
const WAKE_LOG_TAIL_LIMIT = 5;

export function loadMissionState(dir: string): MissionFiles {
  const missionPath = missionMdPath(dir);
  if (!existsSync(missionPath)) throw new Error(`mission.md not found in ${dir}`);

  const statePath = stateJsonPath(dir);
  if (!existsSync(statePath)) throw new Error(`state.json not found in ${dir}`);

  let state: MissionStateJson;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as MissionStateJson;
  } catch {
    throw new Error(`state.json in ${dir} is not valid JSON`);
  }
  if (!VALID_FSM_STATES.has(state.fsmState)) {
    throw new Error(`invalid fsmState "${state.fsmState}" in ${dir}/state.json`);
  }

  const mission = readFileSync(missionPath, 'utf8');
  const planPath = planMdPath(dir);
  const plan = existsSync(planPath) ? readFileSync(planPath, 'utf8') : '';
  const notesPath = notesMdPath(dir);
  const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
  const recentWakeLog = readRecentWakeLog(dir);

  return { mission, plan, notes, state, recentWakeLog };
}

export function writeMissionState(dir: string, patch: Partial<MissionStateJson>): void {
  const statePath = stateJsonPath(dir);
  const current: MissionStateJson = JSON.parse(readFileSync(statePath, 'utf8')) as MissionStateJson;
  const updated: MissionStateJson = { ...current, ...patch };
  atomicWrite(statePath, JSON.stringify(updated, null, 2));
}

export function appendWakeLog(dir: string, entry: WakeLogEntry): void {
  appendFileSync(wakeLogPath(dir), `${JSON.stringify(entry)}\n`, 'utf8');
}

export function acquireLock(dir: string): boolean {
  try {
    mkdirSync(lockPath(dir));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function releaseLock(dir: string): void {
  try {
    rmdirSync(lockPath(dir));
  } catch {
    // ignore — already released or never acquired
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function readRecentWakeLog(dir: string): WakeLogEntry[] {
  const logPath = wakeLogPath(dir);
  if (!existsSync(logPath)) return [];
  try {
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-WAKE_LOG_TAIL_LIMIT);
    return tail.map(l => JSON.parse(l) as WakeLogEntry);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/state.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/mission/state.ts tests/mission/state.test.ts
git commit -m "feat(mission): state loader, writer, wake-log append, and lock"
```

---

## Task 3: Mission FSM

**Files:**
- Create: `src/mission/fsm.ts`
- Create: `tests/mission/fsm.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/mission/fsm.test.ts
import { describe, expect, test } from 'bun:test';
import { applyTransition, shouldRun } from '../../src/mission/fsm.js';
import type { MissionFsmState } from '../../src/mission/types.js';

describe('shouldRun', () => {
  test('returns true for non-terminal states', () => {
    expect(shouldRun('planning')).toBe(true);
    expect(shouldRun('active')).toBe(true);
    expect(shouldRun('overtime')).toBe(true);
  });
  test('returns false for terminal states', () => {
    expect(shouldRun('complete')).toBe(false);
    expect(shouldRun('abandoned')).toBe(false);
  });
});

describe('applyTransition', () => {
  test('planning → active', () => {
    expect(applyTransition('planning', 'active')).toBe('active');
  });
  test('planning → abandoned', () => {
    expect(applyTransition('planning', 'abandoned')).toBe('abandoned');
  });
  test('active → overtime', () => {
    expect(applyTransition('active', 'overtime')).toBe('overtime');
  });
  test('active → complete', () => {
    expect(applyTransition('active', 'complete')).toBe('complete');
  });
  test('active → abandoned', () => {
    expect(applyTransition('active', 'abandoned')).toBe('abandoned');
  });
  test('overtime → complete', () => {
    expect(applyTransition('overtime', 'complete')).toBe('complete');
  });
  test('overtime → active (step back)', () => {
    expect(applyTransition('overtime', 'active')).toBe('active');
  });
  test('overtime → abandoned', () => {
    expect(applyTransition('overtime', 'abandoned')).toBe('abandoned');
  });
  test('returns current state when sentinel is undefined (no transition)', () => {
    expect(applyTransition('active', undefined)).toBe('active');
  });
  test('returns current state for invalid sentinel', () => {
    expect(applyTransition('active', 'bogus')).toBe('active');
  });
  test('throws on transition from terminal state', () => {
    expect(() => applyTransition('complete', 'active')).toThrow(/terminal/);
    expect(() => applyTransition('abandoned', 'active')).toThrow(/terminal/);
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/fsm.test.ts
```
Expected: fails with "Cannot find module '../../src/mission/fsm.js'"

- [ ] **Step 3: Implement fsm.ts**

```typescript
// src/mission/fsm.ts
// Mission FSM: valid state transitions for Phase 13.5 scheduled missions.

import type { MissionFsmState } from './types.js';

const TERMINAL_STATES = new Set<MissionFsmState>(['complete', 'abandoned']);

const TRANSITIONS: Readonly<Record<MissionFsmState, ReadonlySet<MissionFsmState>>> = {
  planning: new Set(['active', 'abandoned']),
  active: new Set(['overtime', 'complete', 'abandoned']),
  overtime: new Set(['active', 'complete', 'abandoned']),
  complete: new Set(),
  abandoned: new Set(),
};

export function shouldRun(state: MissionFsmState): boolean {
  return !TERMINAL_STATES.has(state);
}

export function applyTransition(
  current: MissionFsmState,
  sentinel: string | undefined,
): MissionFsmState {
  if (TERMINAL_STATES.has(current)) {
    throw new Error(`mission is in terminal state "${current}" — no transitions allowed`);
  }
  if (sentinel === undefined) return current;
  const target = sentinel as MissionFsmState;
  if (!TRANSITIONS[current].has(target)) return current;
  return target;
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/fsm.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/mission/fsm.ts tests/mission/fsm.test.ts
git commit -m "feat(mission): FSM state transitions for scheduled wake lifecycle"
```

---

## Task 4: Mission prompt segments

**Files:**
- Create: `src/mission/segments.ts`
- Create: `tests/mission/segments.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/mission/segments.test.ts
import { describe, expect, test } from 'bun:test';
import { buildMissionSegments } from '../../src/mission/segments.js';
import type { MissionFiles } from '../../src/mission/types.js';

const BASE_FILES: MissionFiles = {
  mission: '# Repo Summary\nWrite a three-paragraph summary of the repo.',
  plan: '## Plan\n1. Read README\n2. Write summary',
  notes: 'I found the README at root level.',
  state: {
    fsmState: 'active',
    wakeCount: 2,
    perWakeTurnBudget: 10,
    goal: 'Write a repo summary',
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt: '2026-05-11T01:00:00.000Z',
  },
  recentWakeLog: [
    {
      wakeNumber: 1,
      timestamp: '2026-05-11T00:00:00.000Z',
      fsmStateBefore: 'planning',
      fsmStateAfter: 'active',
      durationMs: 1200,
    },
    {
      wakeNumber: 2,
      timestamp: '2026-05-11T00:30:00.000Z',
      fsmStateBefore: 'active',
      fsmStateAfter: 'active',
      durationMs: 1500,
    },
  ],
};

describe('buildMissionSegments', () => {
  test('returns at least 3 segments (goal, plan, state)', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    expect(segs.length).toBeGreaterThanOrEqual(3);
  });

  test('includes mission goal text in a cacheable segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const cacheableTexts = segs.filter(s => s.cacheable).map(s => s.text).join('\n');
    expect(cacheableTexts).toContain('Repo Summary');
  });

  test('includes plan in a cacheable segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const cacheableTexts = segs.filter(s => s.cacheable).map(s => s.text).join('\n');
    expect(cacheableTexts).toContain('Read README');
  });

  test('includes FSM state and wake count in a cacheable segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const cacheableTexts = segs.filter(s => s.cacheable).map(s => s.text).join('\n');
    expect(cacheableTexts).toContain('active');
    expect(cacheableTexts).toContain('10');
  });

  test('notes.md goes into an ephemeral segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const ephemeralTexts = segs.filter(s => !s.cacheable).map(s => s.text).join('\n');
    expect(ephemeralTexts).toContain('found the README');
  });

  test('wake log tail goes into an ephemeral segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const ephemeralTexts = segs.filter(s => !s.cacheable).map(s => s.text).join('\n');
    expect(ephemeralTexts).toContain('wake 1');
  });

  test('omits plan segment when plan is empty', () => {
    const segs = buildMissionSegments({ ...BASE_FILES, plan: '' }, {});
    const cacheableTexts = segs.filter(s => s.cacheable).map(s => s.text).join('\n');
    expect(cacheableTexts).not.toContain('mission-plan');
  });

  test('omits notes segment when notes is empty', () => {
    const segs = buildMissionSegments({ ...BASE_FILES, notes: '' }, {});
    const ephemeralTexts = segs.filter(s => !s.cacheable).map(s => s.text).join('\n');
    expect(ephemeralTexts).not.toContain('mission-notes');
  });

  test('omits wake log segment when recentWakeLog is empty', () => {
    const segs = buildMissionSegments({ ...BASE_FILES, recentWakeLog: [] }, {});
    const ephemeralTexts = segs.filter(s => !s.cacheable).map(s => s.text).join('\n');
    expect(ephemeralTexts).not.toContain('wake-log');
  });

  test('cacheEnabled:false marks all segments non-cacheable', () => {
    const segs = buildMissionSegments(BASE_FILES, { cacheEnabled: false });
    expect(segs.every(s => !s.cacheable)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/segments.test.ts
```
Expected: fails with "Cannot find module '../../src/mission/segments.js'"

- [ ] **Step 3: Implement segments.ts**

```typescript
// src/mission/segments.ts
// Prompt segment builders for scheduled-mission system prompt injection.

import type { SystemSegment } from '../core/types.js';
import type { MissionFiles, WakeLogEntry } from './types.js';

export type BuildMissionSegmentsOpts = {
  cacheEnabled?: boolean;
};

export function buildMissionSegments(
  files: MissionFiles,
  opts: BuildMissionSegmentsOpts,
): SystemSegment[] {
  const cache = opts.cacheEnabled !== false;
  const segments: SystemSegment[] = [];

  // Cacheable: mission goal (mission.md content)
  segments.push({
    text: `<mission-goal>\n${files.mission.trim()}\n</mission-goal>`,
    cacheable: cache,
  });

  // Cacheable: plan (plan.md content) — omitted if empty
  if (files.plan.trim()) {
    segments.push({
      text: `<mission-plan>\n${files.plan.trim()}\n</mission-plan>`,
      cacheable: cache,
    });
  }

  // Cacheable: FSM state + turn budget
  segments.push({
    text: formatMissionState(files.state),
    cacheable: cache,
  });

  // Ephemeral: notes from last wake (notes.md content)
  if (files.notes.trim()) {
    segments.push({
      text: `<mission-notes>\n${files.notes.trim()}\n</mission-notes>`,
      cacheable: false,
    });
  }

  // Ephemeral: recent wake history
  if (files.recentWakeLog.length > 0) {
    segments.push({
      text: formatWakeLogTail(files.recentWakeLog),
      cacheable: false,
    });
  }

  return segments;
}

function formatMissionState(state: MissionFiles['state']): string {
  return [
    '<mission-state>',
    `fsm-state: ${state.fsmState}`,
    `wake-count: ${state.wakeCount}`,
    `per-wake-turn-budget: ${state.perWakeTurnBudget}`,
    `goal: ${state.goal}`,
    '</mission-state>',
  ].join('\n');
}

function formatWakeLogTail(entries: WakeLogEntry[]): string {
  const lines = entries.map(
    e =>
      `  wake ${e.wakeNumber} (${e.timestamp}): ${e.fsmStateBefore} → ${e.fsmStateAfter}${e.sentinel ? ` [${e.sentinel}]` : ''} ${e.durationMs}ms`,
  );
  return ['<wake-log-tail>', ...lines, '</wake-log-tail>'].join('\n');
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/segments.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/mission/segments.ts tests/mission/segments.test.ts
git commit -m "feat(mission): prompt segment builders for mission state injection"
```

---

## Task 5: AgentDefinition supportsMissionState + scheduled-mission agent

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/agents/loader.ts`
- Create: `bundle-default/agents/scheduled-mission.md`
- Create: `tests/agents/loader.supportsMissionState.test.ts`

- [ ] **Step 1: Write failing test for loader parsing supportsMissionState**

```typescript
// tests/agents/loader.supportsMissionState.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadAgents } from '../../src/agents/loader.js';

function makeAgentFile(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'test-agent.md'), content);
}

describe('loader: supportsMissionState', () => {
  test('parses supportsMissionState: true', async () => {
    const root = join(tmpdir(), `sov-agent-test-${randomUUID()}`);
    makeAgentFile(join(root, 'agents'), `---
name: test-mission-agent
description: A test mission agent
allowedTools:
  - Read
  - Bash(git *)
supportsMissionState: true
---
You are a mission agent.`);

    const registry = await loadAgents({
      harnessHome: root,
      cwd: root,
    });
    const agent = registry.byName.get('test-mission-agent');
    expect(agent).toBeDefined();
    expect(agent?.supportsMissionState).toBe(true);
  });

  test('defaults supportsMissionState to false when absent', async () => {
    const root = join(tmpdir(), `sov-agent-test-${randomUUID()}`);
    makeAgentFile(join(root, 'agents'), `---
name: plain-agent
description: A plain agent
---
Plain system prompt.`);

    const registry = await loadAgents({
      harnessHome: root,
      cwd: root,
    });
    const agent = registry.byName.get('plain-agent');
    expect(agent?.supportsMissionState).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/agents/loader.supportsMissionState.test.ts
```
Expected: agent loads but `supportsMissionState` is `undefined` (field doesn't exist yet)

- [ ] **Step 3: Extend AgentDefinition type**

In `src/agents/types.ts`, add the field:

```typescript
export type AgentDefinition = {
  name: string;
  description: string;
  whenToUse?: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string;
  role?: string;
  maxTurns: number;
  readOnly: boolean;
  supportsMissionState: boolean;   // ADD THIS LINE
  path: string;
  realpath: string;
  dir: string;
  source: AgentSource;
  trustTier: AgentTrustTier;
};
```

- [ ] **Step 4: Add supportsMissionState to FrontmatterSchema in loader.ts**

In `src/agents/loader.ts`, add to `FrontmatterSchema`:

```typescript
const FrontmatterSchema = z
  .object({
    name: z.string().regex(AGENT_NAME_REGEX, ...),
    description: z.string().min(1),
    whenToUse: z.string().optional(),
    systemPrompt: z.string().optional(),
    allowedTools: z.array(z.string()).default([]),
    model: z.string().optional(),
    role: z.string().optional(),
    maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS),
    readOnly: z.boolean().default(false),
    supportsMissionState: z.boolean().default(false),   // ADD THIS LINE
  })
  .passthrough();
```

And in `loadAgentFile`, propagate it in the returned object. Find the `return { ... }` block and add:

```typescript
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.whenToUse !== undefined ? { whenToUse: frontmatter.whenToUse } : {}),
      systemPrompt,
      allowedTools: frontmatter.allowedTools,
      ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
      ...(frontmatter.role !== undefined ? { role: frontmatter.role } : {}),
      maxTurns: frontmatter.maxTurns,
      readOnly: frontmatter.readOnly,
      supportsMissionState: frontmatter.supportsMissionState,   // ADD THIS LINE
      path,
      realpath: rp,
      dir: dirname(path),
      source: classification.source,
      trustTier: classification.trustTier,
    };
```

- [ ] **Step 5: Run tests (expect pass)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/agents/loader.supportsMissionState.test.ts
```
Expected: both tests pass

- [ ] **Step 6: Create bundle-default/agents/scheduled-mission.md**

```markdown
---
name: scheduled-mission
description: One wake of a persistent scheduled mission. Reads prior mission state from the system prompt, does one bounded piece of work, writes notes and files, then declares a state transition.
whenToUse: Invoked by the harness when --state-dir is set. Not for interactive delegation.
allowedTools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash(git log *)
  - Bash(git show *)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(ls *)
  - Bash(find *)
supportsMissionState: true
maxTurns: 20
---

You are a scheduled-mission agent — one wake of a persistent autonomous task.

## Your context

Your mission goal, current plan, FSM state, working notes, and recent wake history are injected into your system prompt in XML blocks above. Read them carefully before taking any action.

## Wake contract

Each wake you must do ONE bounded piece of work and then stop. Your work persists across wakes through:
- Files you write or edit in the working directory
- `notes.md` — your working memory (the harness writes what you emit in the `<mission-notes-update>` block)
- `plan.md` — your phased plan (edit directly if you need to replan)
- `state.json` FSM field — your lifecycle stage

## Sentinel format

At the end of your final response, emit exactly one of these lines to declare your state transition:

```
MISSION_TRANSITION=active
MISSION_TRANSITION=overtime
MISSION_TRANSITION=complete
MISSION_TRANSITION=abandoned
```

Rules:
- Emit `MISSION_TRANSITION=active` when you made progress and more work remains.
- Emit `MISSION_TRANSITION=overtime` when the goal is taking longer than expected.
- Emit `MISSION_TRANSITION=complete` ONLY when all acceptance criteria are provably met (e.g., the output file exists and contains the required content).
- Emit `MISSION_TRANSITION=abandoned` if the goal is impossible or a blocking error prevents progress.
- If you are unsure, emit `MISSION_TRANSITION=active` — the mission will continue on the next wake.

## Notes update

To update your working memory, include a `<mission-notes-update>` block anywhere in your response:

```
<mission-notes-update>
[Your updated working memory here. This replaces notes.md on disk.]
</mission-notes-update>
```

## Per-wake discipline

- Do ONE thing per wake: one file analysis, one draft, one edit pass, one validation run.
- Do NOT attempt the whole goal in one wake — be incremental and reliable.
- Leave the working directory in a consistent state (no half-written files) before emitting the sentinel.
- If you hit an error, document it in notes and emit `MISSION_TRANSITION=active` to retry next wake.
```

- [ ] **Step 7: Verify typecheck and lint pass**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run typecheck && bun run lint
```
Expected: exit 0 on both (fix any type errors from the AgentDefinition change)

- [ ] **Step 8: Commit**

```bash
git add src/agents/types.ts src/agents/loader.ts bundle-default/agents/scheduled-mission.md tests/agents/loader.supportsMissionState.test.ts
git commit -m "feat(agents): add supportsMissionState field; add scheduled-mission agent definition"
```

---

## Task 6: Wire --agent and --state-dir in terminalRepl.ts

**Files:**
- Modify: `src/ui/terminalRepl.ts`

This task has no dedicated test file — the changes are tested via the unit suite (existing tests must still pass) and by a manual smoke test at the end of the plan.

The changes to `terminalRepl.ts` touch three areas:
1. Add fields to `ReplOpts`
2. Modify `openOrResumeSession` to support agent-mode + mission system prompt
3. Add mission lifecycle in the main `runRepl` body (lock, load, FSM check, auto-wake, post-run cleanup)

- [ ] **Step 1: Add fields to ReplOpts**

Find the `export type ReplOpts = {` block (around line 125). Add two optional fields after `replayFixturePath`:

```typescript
  /** Phase 13.5 — run the harness as a specific named agent (uses the
   *  agent's system prompt and allowed-tools list instead of the default
   *  interactive configuration). Required when --state-dir is set. */
  agentName?: string;
  /** Phase 13.5 — scheduled-mission mode. Absolute path to a mission
   *  directory containing mission.md + state.json. Acquires the overlap
   *  lock, injects mission state into the system prompt, runs one
   *  automated wake, writes back state + wake log, then exits. */
  stateDir?: string;
```

- [ ] **Step 2: Add imports for mission modules**

Near the top of `terminalRepl.ts`, after the existing imports, add:

```typescript
import { acquireLock, appendWakeLog, loadMissionState, releaseLock, writeMissionState } from '../mission/state.js';
import { applyTransition, shouldRun } from '../mission/fsm.js';
import { buildMissionSegments } from '../mission/segments.js';
import type { MissionFiles } from '../mission/types.js';
```

- [ ] **Step 3: Modify openOrResumeSession to accept agentDef and missionFiles**

Find the `function openOrResumeSession(` declaration. Add two optional parameters at the end:

```typescript
function openOrResumeSession(
  db: SessionDb,
  opts: ReplOpts,
  bundle: Bundle | null,
  resolved: ResolvedProvider,
  tools: import('../tool/types.js').Tool<unknown, unknown>[],
  skills: SkillRegistry,
  projectScope: import('../memory/scope.js').ProjectScope,
  agentDef?: import('../agents/types.js').AgentDefinition,
  missionFiles?: MissionFiles,
): SessionOpen {
```

In the non-resume branch (around line 1791 in the original), change from:
```typescript
  if (opts.resumeId === undefined) {
    const systemPrompt = buildSystemSegments({
      ...(bundle ? { bundle } : {}),
      tools,
      skills: skills.skills,
      cwd: process.cwd(),
      cacheEnabled: opts.noCache !== true,
      projectScope,
    });
```

To:
```typescript
  if (opts.resumeId === undefined) {
    const cacheEnabled = opts.noCache !== true;
    const baseSegments = buildSystemSegments({
      ...(bundle ? { bundle } : {}),
      tools,
      skills: skills.skills,
      cwd: process.cwd(),
      cacheEnabled,
      projectScope,
    });

    const systemPrompt: SystemSegment[] = agentDef !== undefined
      ? [
          { text: agentDef.systemPrompt, cacheable: cacheEnabled },
          ...(missionFiles !== undefined ? buildMissionSegments(missionFiles, { cacheEnabled }) : []),
          ...baseSegments,
        ]
      : baseSegments;
```

- [ ] **Step 4: Wire mission lifecycle in runRepl**

Find the section of `runRepl` where the session is opened (the call to `openOrResumeSession`), which is around line 1855+ in the full file. 

First, add mission context setup BEFORE the call to `openOrResumeSession`. Add this block right before `const { sessionId, systemPrompt, history, resumed } = openOrResumeSession(...)`:

```typescript
  // Phase 13.5 — mission mode setup
  let missionFiles: MissionFiles | undefined;
  const wakeStartedAt = Date.now();

  if (opts.stateDir !== undefined) {
    if (opts.agentName === undefined) {
      throw new Error('--state-dir requires --agent');
    }
    // Load and validate mission state (throws on malformed dir)
    missionFiles = loadMissionState(opts.stateDir);
    // Terminal-state early exit — clean, not an error
    if (!shouldRun(missionFiles.state.fsmState)) {
      process.stdout.write(
        `[mission] state is "${missionFiles.state.fsmState}" (terminal) — nothing to do\n`,
      );
      return;
    }
    // Overlap lock — exit 0 if another wake is in progress
    if (!acquireLock(opts.stateDir)) {
      process.stdout.write('[mission] another wake is already running (lock held) — skipping\n');
      return;
    }
  }

  // Resolve the agent definition when --agent is given
  const agentDef = opts.agentName !== undefined
    ? loadedAgents.byName.get(opts.agentName)
    : undefined;

  if (opts.agentName !== undefined && agentDef === undefined) {
    if (opts.stateDir !== undefined) releaseLock(opts.stateDir);
    throw new Error(`agent "${opts.agentName}" not found`);
  }

  if (opts.stateDir !== undefined && agentDef !== undefined && !agentDef.supportsMissionState) {
    releaseLock(opts.stateDir);
    throw new Error(`agent "${opts.agentName}" does not declare supportsMissionState: true`);
  }
```

Then, update the call to `openOrResumeSession` to pass the new arguments:

```typescript
  const { sessionId, systemPrompt, history, resumed } = openOrResumeSession(
    db,
    opts,
    bundle,
    resolved,
    toolPool,
    loadedSkills,
    projectScope,
    agentDef,
    missionFiles,
  );
```

- [ ] **Step 5: Restrict tool pool when agent specifies allowedTools**

Find where `toolPool` is assembled (around the `assembleToolPool` call). After that assembly, add:

```typescript
  // Phase 13.5 — when running as a named agent, restrict the tool pool
  // to the agent's allowedTools list (same filtering as AgentTool does for children).
  if (agentDef !== undefined && agentDef.allowedTools.length > 0) {
    const { buildToolScope } = await import('./commands/toolScope.js');  // already imported at top
    const scopedPool = buildToolScope({ allowedTools: agentDef.allowedTools, pool: toolPool });
    toolPool = scopedPool.tools;
  }
```

Note: `buildToolScope` is already imported. The actual import may need adjustment — check the existing imports and use the already-available symbol.

Actually, looking at the file, `buildToolScope` is already imported from `'../commands/toolScope.js'`. Use it directly:

```typescript
  if (agentDef !== undefined && agentDef.allowedTools.length > 0) {
    const scoped = buildToolScope({ allowedTools: agentDef.allowedTools, pool: toolPool });
    toolPool = scoped.tools;
  }
```

Check the `buildToolScope` signature in `src/commands/toolScope.ts` to confirm the parameter shape.

- [ ] **Step 6: Add auto-wake injection in the main loop**

Find the main `while (!closed ...)` loop start. Add a mission-mode fast path BEFORE the loop:

```typescript
  // Phase 13.5 — mission mode: inject automated wake message, run once, then exit
  if (opts.stateDir !== undefined && missionFiles !== undefined) {
    const wakeNumber = missionFiles.state.wakeCount + 1;
    const wakeMessage = `Wake #${wakeNumber}: please continue working on your mission. Read your mission goal, plan, and notes from the system prompt, then do one bounded piece of work.`;
    process.stdout.write(chalk.gray(`[mission] starting wake #${wakeNumber} (${missionFiles.state.fsmState})\n`));
    await runModelTurn([{ type: 'text', text: wakeMessage }]);
    // Collect final assistant text from history for sentinel parsing
    const lastMsg = history.at(-1);
    const lastAssistantText =
      lastMsg?.role === 'assistant'
        ? lastMsg.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text)
            .join('\n')
        : '';
    // Parse MISSION_TRANSITION=<state> sentinel
    const sentinelMatch = lastAssistantText.match(/MISSION_TRANSITION=(\w+)/);
    const sentinelValue = sentinelMatch?.[1];
    // Parse notes update from <mission-notes-update>...</mission-notes-update>
    const notesMatch = lastAssistantText.match(/<mission-notes-update>([\s\S]*?)<\/mission-notes-update>/);
    if (notesMatch?.[1]) {
      const { writeFileSync } = await import('node:fs');
      const { notesMdPath } = await import('../mission/paths.js');
      writeFileSync(notesMdPath(opts.stateDir), notesMatch[1].trim(), 'utf8');
    }
    // Apply FSM transition + write state + append wake log
    const stateBefore = missionFiles.state.fsmState;
    const stateAfter = applyTransition(stateBefore, sentinelValue);
    writeMissionState(opts.stateDir, {
      fsmState: stateAfter,
      wakeCount: wakeNumber,
      updatedAt: new Date().toISOString(),
    });
    appendWakeLog(opts.stateDir, {
      wakeNumber,
      timestamp: new Date().toISOString(),
      fsmStateBefore: stateBefore,
      fsmStateAfter: stateAfter,
      ...(sentinelValue !== undefined ? { sentinel: sentinelValue } : {}),
      durationMs: Date.now() - wakeStartedAt,
    });
    releaseLock(opts.stateDir);
    process.stdout.write(chalk.gray(`[mission] wake #${wakeNumber} complete — state: ${stateAfter}\n`));
    return;  // exit REPL; session recorded in DB for audit
  }
```

> Note: The imports for `writeFileSync` and `notesMdPath` are static imports added at the top of the file in Step 2; the dynamic `await import(...)` pattern is used only to avoid hoisting issues if the existing code style requires it. Prefer static top-level imports consistent with the rest of the file.

- [ ] **Step 7: Ensure lock is released in error paths**

In the `runRepl` function, wrap the entire body (after mission setup) in a try/finally that releases the lock. Find the existing cleanup code near the end of `runRepl` and add a lock-release guard:

```typescript
  // At the very end of runRepl, after the session-close trajectory write block,
  // ensure the lock is released even if an exception propagates:
  // (add this to the existing finally block or the session-close block)
  if (opts.stateDir !== undefined) {
    releaseLock(opts.stateDir);
  }
```

Actually, because `runRepl` is an `async function` that currently has no top-level try/finally, the lock release in the happy path (inside the if block in Step 6) handles normal flow. For exception paths, we need to add a top-level guard. Add after the mission setup block (after acquiring the lock):

```typescript
  // Ensure lock is released on any early return or exception from this point forward
  const maybeReleaseLock = () => {
    if (opts.stateDir !== undefined) releaseLock(opts.stateDir);
  };
```

Then at every `return` after lock acquisition (including the auto-wake path's final `return`), call `maybeReleaseLock()` before returning. For exception paths, wrap the block from after lock acquisition to the end of the function in a try/finally block.

- [ ] **Step 8: Run full unit suite (must still pass)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run typecheck && bun run lint && bun test
```
Expected: all existing tests pass + 0 new failures. Fix any typecheck errors from the AgentDefinition.supportsMissionState addition propagating through existing test fixtures.

- [ ] **Step 9: Commit**

```bash
git add src/ui/terminalRepl.ts
git commit -m "feat(repl): wire --agent and --state-dir for scheduled-mission mode"
```

---

## Task 7: CLI flags, harness bin alias, and mission-init subcommand

**Files:**
- Modify: `src/main.ts`
- Modify: `package.json`
- Create: `src/cli/missionInit.ts`
- Create: `tests/mission/missionInit.test.ts`

- [ ] **Step 1: Write failing tests for missionInit**

```typescript
// tests/mission/missionInit.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { formatMissionInitResult, runMissionInit } from '../../src/cli/missionInit.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sov-mission-init-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('runMissionInit', () => {
  test('creates a well-formed mission dir', () => {
    const parent = makeTmpDir();
    const missionDir = join(parent, 'my-mission');
    const result = runMissionInit({ dir: missionDir, goal: 'Write a summary document.' });
    expect(result.ok).toBe(true);
    expect(existsSync(join(missionDir, 'mission.md'))).toBe(true);
    expect(existsSync(join(missionDir, 'plan.md'))).toBe(true);
    expect(existsSync(join(missionDir, 'notes.md'))).toBe(true);
    expect(existsSync(join(missionDir, 'state.json'))).toBe(true);
  });

  test('mission.md contains the goal', () => {
    const parent = makeTmpDir();
    const missionDir = join(parent, 'goal-mission');
    runMissionInit({ dir: missionDir, goal: 'Build a widget.' });
    const mission = readFileSync(join(missionDir, 'mission.md'), 'utf8');
    expect(mission).toContain('Build a widget.');
  });

  test('state.json starts in planning state with wakeCount 0', () => {
    const parent = makeTmpDir();
    const missionDir = join(parent, 'state-mission');
    runMissionInit({ dir: missionDir, goal: 'Test goal.' });
    const state = JSON.parse(readFileSync(join(missionDir, 'state.json'), 'utf8'));
    expect(state.fsmState).toBe('planning');
    expect(state.wakeCount).toBe(0);
    expect(state.perWakeTurnBudget).toBe(10);
    expect(state.goal).toBe('Test goal.');
  });

  test('fails if dir already exists and is a mission dir', () => {
    const parent = makeTmpDir();
    const missionDir = join(parent, 'existing-mission');
    runMissionInit({ dir: missionDir, goal: 'First.' });
    const result = runMissionInit({ dir: missionDir, goal: 'Second.' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
  });

  test('succeeds with force flag on existing mission dir', () => {
    const parent = makeTmpDir();
    const missionDir = join(parent, 'force-mission');
    runMissionInit({ dir: missionDir, goal: 'First.' });
    const result = runMissionInit({ dir: missionDir, goal: 'Second.', force: true });
    expect(result.ok).toBe(true);
    const state = JSON.parse(readFileSync(join(missionDir, 'state.json'), 'utf8'));
    expect(state.goal).toBe('Second.');
  });
});

describe('formatMissionInitResult', () => {
  test('formats success message', () => {
    const parent = makeTmpDir();
    const missionDir = join(parent, 'fmt-mission');
    const result = runMissionInit({ dir: missionDir, goal: 'A goal.' });
    const output = formatMissionInitResult(result);
    expect(output).toContain('bootstrapped');
    expect(output).toContain(missionDir);
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/missionInit.test.ts
```
Expected: fails with "Cannot find module '../../src/cli/missionInit.js'"

- [ ] **Step 3: Implement missionInit.ts**

```typescript
// src/cli/missionInit.ts
// Phase 13.5 — `sov mission-init <dir> --goal "..."` CLI logic.
// Scaffolds a mission directory with the required contract files.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { notesMdPath, planMdPath, missionMdPath, stateJsonPath } from '../mission/paths.js';
import type { MissionStateJson } from '../mission/types.js';

export type MissionInitOpts = {
  dir: string;
  goal: string;
  perWakeTurnBudget?: number;
  force?: boolean;
};

export type MissionInitResult = {
  ok: boolean;
  missionDir: string;
  written: string[];
  error?: string;
};

export function runMissionInit(opts: MissionInitOpts): MissionInitResult {
  const dir = resolve(opts.dir);
  const stateFile = stateJsonPath(dir);

  if (existsSync(stateFile) && opts.force !== true) {
    return {
      ok: false,
      missionDir: dir,
      written: [],
      error: `mission directory already exists at ${dir} — pass --force to overwrite`,
    };
  }

  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const now = new Date().toISOString();

  const missionMd = `# Mission\n\n${opts.goal}\n`;
  writeFileSync(missionMdPath(dir), missionMd, 'utf8');
  written.push('mission.md');

  const planMd = `## Plan\n\n_Add your phased plan here. Each step should have clear acceptance criteria._\n`;
  writeFileSync(planMdPath(dir), planMd, 'utf8');
  written.push('plan.md');

  writeFileSync(notesMdPath(dir), '', 'utf8');
  written.push('notes.md');

  const state: MissionStateJson = {
    fsmState: 'planning',
    wakeCount: 0,
    perWakeTurnBudget: opts.perWakeTurnBudget ?? 10,
    goal: opts.goal,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  written.push('state.json');

  return { ok: true, missionDir: dir, written };
}

export function formatMissionInitResult(result: MissionInitResult): string {
  if (!result.ok) {
    return `sov mission-init: ${result.error}\n`;
  }
  const lines = [
    `sov mission-init: bootstrapped mission directory at ${result.missionDir}`,
    '',
    'Wrote:',
    ...result.written.map(f => `  ${f}`),
    '',
    'Next steps:',
    '  1. Edit plan.md — add phased steps with acceptance criteria.',
    '  2. Run a wake manually:',
    `     sov chat --agent scheduled-mission --state-dir ${result.missionDir}`,
    '  3. Once verified, install the launchd scheduler:',
    '     ~/code/sovereign-ai-ops/mission/install.sh <mission-dir> <interval-minutes>',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test tests/mission/missionInit.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Add harness bin alias to package.json**

Read the current `package.json` `"bin"` section (currently `"sov": "./src/main.ts"`) and expand it:

```json
"bin": {
  "sov": "./src/main.ts",
  "harness": "./src/main.ts"
},
```

- [ ] **Step 6: Add --agent, --state-dir flags and mission-init subcommand to main.ts**

In `src/main.ts`, find the `chat` command's `.action(async (opts) => {` section. Add two options before `.action`:

```typescript
    .option('--agent <name>', 'run as a named agent (uses the agent definition\'s system prompt and allowed tools)')
    .option('--state-dir <path>', 'scheduled-mission mode: path to a mission directory (requires --agent with supportsMissionState:true)')
```

And update the `.action` body to pass the new options to `runRepl`:

```typescript
    .action(async (opts) => {
      const bundlePath = resolveBundlePath(opts.bundle);
      const { runRepl } = await import('./ui/terminalRepl.js');
      await runRepl({
        ...(bundlePath !== null ? { bundlePath } : {}),
        ...(opts.provider !== undefined ? { providerName: opts.provider } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        maxTokens: opts.maxTokens,
        permissionMode: opts.permissionMode,
        ...(opts.resume !== undefined ? { resumeId: opts.resume } : {}),
        ...(opts.db !== undefined ? { dbPath: opts.db } : {}),
        ...(opts.cache === false ? { noCache: true } : {}),
        preflight: opts.preflight !== false,
        ...(opts.transcript !== undefined ? { transcriptPath: opts.transcript } : {}),
        ...(opts.verbose === true ? { verbose: true } : {}),
        ...(opts.legacyInput === true ? { legacyInput: true } : {}),
        ...(opts.captureFixture !== undefined ? { captureFixturePath: opts.captureFixture } : {}),
        ...(opts.replayFixture !== undefined ? { replayFixturePath: opts.replayFixture } : {}),
        ...(opts.agent !== undefined ? { agentName: opts.agent } : {}),
        ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
      });
    });
```

Then add the `mission-init` subcommand. Find the end of the existing commands (before `await program.parseAsync(argv)`) and add:

```typescript
  const missionCmd = program
    .command('mission')
    .description('Manage scheduled autonomous missions');

  missionCmd
    .command('init <dir>')
    .description('Scaffold a new mission directory with mission.md, plan.md, notes.md, state.json')
    .option('--goal <text>', 'mission goal statement (required)')
    .option('--per-wake-turns <n>', 'tool-call budget per wake', parsePositiveInt, 10)
    .option('--force', 'overwrite an existing state.json')
    .action(async (dir: string, opts) => {
      if (opts.goal === undefined) {
        process.stderr.write('sov mission init: --goal <text> is required\n');
        process.exit(1);
      }
      const { runMissionInit, formatMissionInitResult } = await import('./cli/missionInit.js');
      const result = runMissionInit({
        dir,
        goal: opts.goal,
        ...(opts.perWakeTurns !== undefined ? { perWakeTurnBudget: opts.perWakeTurns } : {}),
        ...(opts.force === true ? { force: true } : {}),
      });
      const out = formatMissionInitResult(result);
      if (result.ok) {
        process.stdout.write(out);
        process.exit(0);
      } else {
        process.stderr.write(out);
        process.exit(1);
      }
    });
```

- [ ] **Step 7: Run typecheck + lint + full test suite**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run typecheck && bun run lint && bun test
```
Expected: all pass. Fix any type errors.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts package.json src/cli/missionInit.ts tests/mission/missionInit.test.ts
git commit -m "feat(cli): add --agent, --state-dir flags, mission-init subcommand, harness bin alias"
```

---

## Task 8: Verification, semantic test check, and sov upgrade

- [ ] **Step 1: Run full unit suite and confirm count**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun test
```
Expected: baseline 1717 + new tests. Note the count.

- [ ] **Step 2: Run typecheck and lint (must be clean)**

```bash
cd /Users/julie/code/sovereign-ai-harness && bun run typecheck && bun run lint
```
Expected: exit 0 on both

- [ ] **Step 3: Smoke test — mission-init creates a valid dir**

```bash
sov mission init /tmp/sov-test-mission --goal "Write a one-sentence test summary."
```
Expected: output says "bootstrapped mission directory" and lists the 4 written files.

```bash
ls /tmp/sov-test-mission/
```
Expected: `mission.md  notes.md  plan.md  state.json`

```bash
cat /tmp/sov-test-mission/state.json
```
Expected: JSON with `fsmState: "planning"`, `wakeCount: 0`, `goal: "Write a one-sentence test summary."`

- [ ] **Step 4: Smoke test — harness binary alias works**

```bash
harness --version
```
Expected: prints version (same as `sov --version`)

```bash
harness --help | grep state-dir
```
Expected: `--state-dir` appears in the help output (confirms the ops repo install.sh check will pass)

- [ ] **Step 5: Smoke test — terminal FSM state exits cleanly**

Manually set the state to `complete` and verify the harness exits without running:

```bash
echo '{"fsmState":"complete","wakeCount":2,"perWakeTurnBudget":10,"goal":"done","createdAt":"2026-05-11T00:00:00.000Z","updatedAt":"2026-05-11T00:00:00.000Z"}' > /tmp/sov-test-mission/state.json
sov chat --agent scheduled-mission --state-dir /tmp/sov-test-mission
```
Expected: prints `[mission] state is "complete" (terminal) — nothing to do` and exits immediately

- [ ] **Step 6: Smoke test — first live wake (interactive sanity check)**

Reset the state dir to planning and run one live wake:

```bash
sov mission init /tmp/sov-test-wake-mission --goal "Count the number of files in /tmp and write the count to count.txt" --force
sov chat --agent scheduled-mission --state-dir /tmp/sov-test-wake-mission
```
Expected:
- `[mission] starting wake #1 (planning)` appears
- Agent runs autonomously (tool calls visible)
- `[mission] wake #1 complete — state: <new-state>` appears
- Process exits
- `cat /tmp/sov-test-wake-mission/wake_log.jsonl` shows one line
- `cat /tmp/sov-test-wake-mission/state.json` shows `wakeCount: 1`

- [ ] **Step 7: Update semantic testing docs**

Read `docs/semantic-testing.md` and check if a new row is needed in the run-policy mapping table for `--state-dir` / `scheduled-mission`. If the table tracks slash commands and CLI surfaces, add:

```
| sov chat --state-dir | "mission" | Run when touching mission lifecycle code in terminalRepl.ts or src/mission/ |
```

- [ ] **Step 8: Append testing log entry**

Add an entry to `docs/testing-log-2026-04-27.md`:

```
## 2026-05-11 — Phase 13.5 scheduled-mission sub-agents

**Scope:** Phase 13.5 — mission types/paths/state/fsm/segments, agentDef supportsMissionState,
scheduled-mission.md agent, --agent/--state-dir flags, mission-init CLI, harness bin alias.

**Unit suite:** 1717 baseline + N new = 1717+N passing

**Typecheck:** clean (tsc --noEmit exit 0)
**Lint:** clean (biome exit 0, 2 pre-existing shellSemantics warnings accepted)

**Manual smoke tests:**
- sov mission init — created valid dir with 4 required files ✓
- harness --help | grep state-dir — alias works, flag appears ✓
- Terminal FSM state (complete) → exits immediately without running ✓
- Live wake with real agent — one bounded turn, wake_log.jsonl written, state.json updated ✓

**Regressions:** none observed
```

- [ ] **Step 9: Run sov upgrade**

```bash
sov upgrade
```
Expected: installs the new binary with `harness` alias and `--state-dir` support

- [ ] **Step 10: Verify harness binary after upgrade**

```bash
harness --version
harness --help | grep state-dir
```
Expected: both work with the updated binary

- [ ] **Step 11: Commit docs**

```bash
git add docs/semantic-testing.md docs/testing-log-2026-04-27.md
git commit -m "docs(phase-13.5): update semantic testing docs and testing log"
```

---

## Self-review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| Mission-dir layout contract (mission.md, plan.md, state.json, notes.md, wake_log.jsonl, .lock/) | Task 1 (paths) + Task 2 (state loader enforces) |
| `src/mission/state.ts` loader + atomic-rename writer | Task 2 |
| `src/mission/fsm.ts` state machine | Task 3 |
| `src/mission/segments.ts` cacheable + ephemeral segments | Task 4 |
| `--state-dir` flag on `sov chat` | Task 7 (CLI) + Task 6 (REPL wiring) |
| `--agent scheduled-mission` flag | Task 7 (CLI) + Task 6 (REPL wiring) |
| AgentDefinition.supportsMissionState | Task 5 |
| `bundle-default/agents/scheduled-mission.md` | Task 5 |
| MISSION_TRANSITION=<state> sentinel parsing | Task 6 |
| Wake log append + FSM state write-back | Task 6 |
| Overlap lock (.lock subdirectory) | Task 2 (acquire/release) + Task 6 (wire in REPL) |
| `sov mission init` subcommand | Task 7 |
| `harness` bin alias | Task 7 |
| notes.md update via `<mission-notes-update>` block | Task 6 |
| Ops repo scripts work (they're already there) | Task 8 (verify harness alias + --help check) |

All 8 build plan items covered.

### Type consistency check

- `MissionFsmState` — defined in `types.ts` Task 1, used in `state.ts` Task 2, `fsm.ts` Task 3, `segments.ts` Task 4, and `terminalRepl.ts` Task 6. Consistent throughout.
- `MissionFiles` — defined in `types.ts` Task 1, returned by `loadMissionState` in Task 2, passed to `buildMissionSegments` in Task 4, and threaded through `openOrResumeSession` in Task 6. Consistent.
- `WakeLogEntry` — defined in `types.ts` Task 1, used in `state.ts` (appendWakeLog) Task 2 and `segments.ts` Task 4. Consistent.
- `AgentDefinition.supportsMissionState` — added to `types.ts` in Task 5 step 3, added to loader in Task 5 step 4. Consistent.
- `ReplOpts.agentName` / `ReplOpts.stateDir` — added in Task 6 step 1, consumed in Task 6 steps 2–7, passed from `main.ts` in Task 7 step 6. Consistent.

### Placeholder scan

No TBDs or vague steps remain. All code blocks are complete.
