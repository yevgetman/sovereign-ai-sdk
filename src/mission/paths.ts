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
