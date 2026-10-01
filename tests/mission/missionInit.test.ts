// tests/mission/missionInit.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatMissionInitResult,
  quoteMissionPath,
  runMissionInit,
} from '../../src/cli/missionInit.js';

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirsToClean.length = 0;
});

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sov-mission-init-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirsToClean.push(dir);
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

  // FIX 1c — the next-steps blurb must point at the real `sov mission run
  // --state-dir` command, not the deprecated `sov chat --agent ...` form that
  // was removed in the Phase-16 revert.
  test('next-steps references `sov mission run --state-dir`, not the retired `sov chat`', () => {
    const parent = makeTmpDir();
    const missionDir = join(parent, 'next-steps-mission');
    const result = runMissionInit({ dir: missionDir, goal: 'A goal.' });
    const output = formatMissionInitResult(result);
    expect(output).toContain(`sov mission run --state-dir ${quoteMissionPath(missionDir)}`);
    expect(output).not.toContain('sov chat');
    // Wakes are an external timer invoking `sov mission run`. There is no
    // schedule/install subcommand (main.ts registers only init and run).
    expect(output).toContain('launchd, cron, or systemd');
    expect(output).not.toContain('sov mission --help');
    expect(output).not.toContain('sov mission install');
    expect(output).not.toContain('install.sh');
    expect(output).not.toContain('sovereign-ai-ops');
    expect(output).not.toContain('with sov itself');
  });
});

test('manual guidance keeps spaces, apostrophes, and shell syntax in one path argument', () => {
  const missionDir = join(makeTmpDir(), "mission space ' $(echo wrong)");
  const result = runMissionInit({ dir: missionDir, goal: 'Test fresh path.' });
  const output = formatMissionInitResult(result);
  const command = output
    .split('\n')
    .find((line) => line.trim().startsWith('sov mission run'))
    ?.trim();
  expect(command).toBeDefined();
  if (!command) throw new Error('missing manual mission command');
  // Replace only the command name with printf. The shell must return one
  // argument with the exact path, without evaluating anything inside it.
  const parsed = spawnSync(
    '/bin/sh',
    ['-c', command.replace('sov mission run --state-dir', "printf '%s\\n'")],
    { encoding: 'utf8' },
  );
  expect(parsed.status).toBe(0);
  expect(parsed.stdout.trimEnd()).toBe(missionDir);
  expect(JSON.parse(readFileSync(join(missionDir, 'state.json'), 'utf8')).goal).toBe(
    'Test fresh path.',
  );
});
