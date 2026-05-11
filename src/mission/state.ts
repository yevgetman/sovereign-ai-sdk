// src/mission/state.ts
// Mission-dir loader, writer, wake-log append, and overlap lock for Phase 13.5.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
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
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-WAKE_LOG_TAIL_LIMIT);
    return tail.map((l) => JSON.parse(l) as WakeLogEntry);
  } catch {
    return [];
  }
}
