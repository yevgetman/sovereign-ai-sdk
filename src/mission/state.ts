// src/mission/state.ts
// Mission-dir loader, writer, wake-log append, and overlap lock for Phase 13.5.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { releaseLock as releaseLockDir, tryAcquireOnce } from '../cron/lockUtil.js';
import {
  lockPath,
  missionMdPath,
  notesMdPath,
  planMdPath,
  stateJsonPath,
  wakeLogPath,
} from './paths.js';
import type { MissionFiles, MissionStateJson, WakeLogEntry } from './types.js';

const VALID_FSM_STATES = new Set<string>([
  'planning',
  'active',
  'overtime',
  'complete',
  'abandoned',
]);
const WAKE_LOG_TAIL_LIMIT = 5;

export function loadMissionState(dir: string): MissionFiles {
  const missionPath = missionMdPath(dir);
  if (!existsSync(missionPath)) throw new Error(`mission.md not found in ${dir}`);

  const state = readState(dir);
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
  const current = readState(dir);
  const updated: MissionStateJson = { ...current, ...patch };
  if (!VALID_FSM_STATES.has(updated.fsmState)) {
    throw new Error(`invalid fsmState "${updated.fsmState}"`);
  }
  atomicWrite(stateJsonPath(dir), JSON.stringify(updated, null, 2));
}

function readState(dir: string): MissionStateJson {
  const statePath = stateJsonPath(dir);
  if (!existsSync(statePath)) throw new Error(`state.json not found in ${dir}`);
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as MissionStateJson;
  } catch {
    throw new Error(`state.json in ${dir} is not valid JSON`);
  }
}

export function appendWakeLog(dir: string, entry: WakeLogEntry): void {
  appendFileSync(wakeLogPath(dir), `${JSON.stringify(entry)}\n`, 'utf8');
}

// Overlap guard for the scheduled-mission wake. Delegates to the shared
// PID-stamped lock primitive (src/cron/lockUtil.ts) so a wake that crashes /
// is SIGKILLed / loses power leaves a *stale* lock that the next wake can
// reclaim — a bare mkdir-only lock (the pre-FIX-2 behavior) halted the mission
// forever. Returns true when the lock was acquired (fresh or reclaimed from a
// dead owner), false when a *live* process still holds it.
export function acquireLock(dir: string): boolean {
  return tryAcquireOnce(lockPath(dir));
}

// Removes the lock dir + its PID file. Tolerant of the dir not existing
// (already released or never acquired); never throws so callers can release in
// a finally block.
export function releaseLock(dir: string): void {
  releaseLockDir(lockPath(dir));
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function readRecentWakeLog(dir: string): WakeLogEntry[] {
  const logPath = wakeLogPath(dir);
  if (!existsSync(logPath)) return [];
  try {
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-WAKE_LOG_TAIL_LIMIT);
    return tail.flatMap((l) => {
      try {
        return [JSON.parse(l) as WakeLogEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
