// src/cli/missionInit.ts
// Phase 13.5 — `sov mission init <dir> --goal "..."` CLI logic.
// Scaffolds a mission directory with the required contract files.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { missionMdPath, notesMdPath, planMdPath, stateJsonPath } from '../mission/paths.js';
import type { MissionStateJson } from '../mission/types.js';

export const DEFAULT_PER_WAKE_TURN_BUDGET = 10;

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

  const planMd =
    '## Plan\n\n_Add your phased plan here. Each step should have clear acceptance criteria._\n';
  writeFileSync(planMdPath(dir), planMd, 'utf8');
  written.push('plan.md');

  writeFileSync(notesMdPath(dir), '', 'utf8');
  written.push('notes.md');

  const state: MissionStateJson = {
    fsmState: 'planning',
    wakeCount: 0,
    perWakeTurnBudget: opts.perWakeTurnBudget ?? DEFAULT_PER_WAKE_TURN_BUDGET,
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
    ...result.written.map((f) => `  ${f}`),
    '',
    'Next steps:',
    '  1. Edit plan.md — add phased steps with acceptance criteria.',
    '  2. Run a wake manually:',
    `     sov mission run --state-dir ${result.missionDir}`,
    '  3. Once verified, install the launchd scheduler:',
    '     ~/code/sovereign-ai-ops/mission/install.sh <mission-dir> <interval-minutes>',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
