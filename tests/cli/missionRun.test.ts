// Phase 16.0b — verifies runMissionWake() is callable headlessly given a
// pre-initialized mission directory and that it respects the overlap lock.
//
// FIX 1 (HIGH) — also asserts the `sov mission run --state-dir <dir>`
// subcommand is registered in the CLI (it was lost in the Phase-16 revert,
// orphaning runMissionWake as dead code) and FIX 1b — that the per-wake turn
// budget bounds the wake's query() maxTurns.

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMissionInit } from '../../src/cli/missionInit.js';
import {
  normalizePerWakeTurnBudget,
  resolveWakeMaxTurns,
  runMissionWake,
} from '../../src/cli/missionRun.js';

const MAIN_TS = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/main.ts');

describe('runMissionWake', () => {
  it('exits early without error when the FSM is in a terminal state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-wake-'));
    try {
      const init = runMissionInit({ dir, goal: 'test mission' });
      expect(init.ok).toBe(true);

      // Force state to a terminal value. The FSM (src/mission/fsm.ts) treats
      // `complete` and `abandoned` as terminal. The state.json field is
      // `fsmState` (per src/mission/types.ts).
      const stateFile = join(dir, 'state.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      state.fsmState = 'complete';
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

      const result = await runMissionWake({ stateDir: dir });
      expect(result.exitedEarly).toBe(true);
      expect(result.reason).toContain('terminal');
      // The lock dir should not be left dangling on the early-exit path.
      expect(existsSync(join(dir, '.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns lockHeld result when a concurrent wake holds the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-wake-lock-'));
    try {
      const init = runMissionInit({ dir, goal: 'test mission' });
      expect(init.ok).toBe(true);

      // Create the lock directory manually to simulate an in-flight wake. It
      // must carry a LIVE owner PID — a bare/no-PID lock is now treated as
      // stale and reclaimed (FIX 2), so to exercise the lockHeld path we stamp
      // this (alive) test process as the holder.
      mkdirSync(join(dir, '.lock'));
      writeFileSync(join(dir, '.lock', 'pid'), String(process.pid), 'utf8');

      const result = await runMissionWake({ stateDir: dir });
      expect(result.lockHeld).toBe(true);
      // The pre-existing lock must NOT be released by the caller that
      // couldn't acquire it (otherwise we'd clobber the actual holder).
      expect(existsSync(join(dir, '.lock'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveWakeMaxTurns (FIX 1b)', () => {
  it('uses the per-wake turn budget when it is below the agent ceiling', () => {
    // Budget 10, agent maxTurns 50 → the budget wins (the bug: query() ignored
    // the budget and defaulted to 100 turns).
    expect(resolveWakeMaxTurns(10, 50)).toBe(10);
  });

  it('caps at the agent ceiling when the budget exceeds it', () => {
    expect(resolveWakeMaxTurns(80, 50)).toBe(50);
  });

  it('falls back to the budget when no agent ceiling is given', () => {
    expect(resolveWakeMaxTurns(10, undefined)).toBe(10);
  });

  it('never returns the 100-turn query default for a default budget', () => {
    // The whole point: a default per-wake budget (10) must bound the wake.
    expect(resolveWakeMaxTurns(10, 50)).not.toBe(100);
    expect(resolveWakeMaxTurns(10, 50)).toBeLessThanOrEqual(10);
  });
});

describe('normalizePerWakeTurnBudget (#39)', () => {
  it('passes through a valid positive integer budget', () => {
    expect(normalizePerWakeTurnBudget(10)).toBe(10);
    expect(normalizePerWakeTurnBudget(1)).toBe(1);
    expect(normalizePerWakeTurnBudget(50)).toBe(50);
  });

  it('floors a fractional budget to a whole number of turns', () => {
    expect(normalizePerWakeTurnBudget(10.9)).toBe(10);
  });

  it('falls back to the default for a 0, negative, NaN, or non-finite budget', () => {
    // The bug: any of these as maxTurns makes query() run ZERO turns while
    // still advancing FSM state — silent forward progress with no work done.
    expect(normalizePerWakeTurnBudget(0)).toBe(10);
    expect(normalizePerWakeTurnBudget(-5)).toBe(10);
    expect(normalizePerWakeTurnBudget(Number.NaN)).toBe(10);
    expect(normalizePerWakeTurnBudget(Number.POSITIVE_INFINITY)).toBe(10);
  });

  it('falls back to the default for a missing / non-numeric budget', () => {
    expect(normalizePerWakeTurnBudget(undefined)).toBe(10);
    expect(normalizePerWakeTurnBudget(null)).toBe(10);
    expect(normalizePerWakeTurnBudget('10')).toBe(10);
    expect(normalizePerWakeTurnBudget({})).toBe(10);
  });
});

describe('resolveWakeMaxTurns — invalid budget (#39)', () => {
  it('never collapses to zero turns when the budget is 0 / NaN', () => {
    // Without the #39 guard, a 0 budget would make Math.min(0, agentMaxTurns)
    // = 0 → query() runs zero turns. The guard substitutes the default 10.
    expect(resolveWakeMaxTurns(0, 50)).toBe(10);
    expect(resolveWakeMaxTurns(Number.NaN, 50)).toBe(10);
  });

  it('still caps the substituted default at a lower agent ceiling', () => {
    expect(resolveWakeMaxTurns(0, 3)).toBe(3);
  });
});

describe('sov mission run — CLI registration (FIX 1)', () => {
  it('registers the `run` subcommand under `mission` (so the wake path is reachable)', () => {
    const res = spawnSync('bun', [MAIN_TS, 'mission', '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    // The command group must list `run` alongside `init`.
    expect(out).toMatch(/\brun\b/);
    expect(out).toContain('init');
  });

  it('`mission run --help` documents the required --state-dir option', () => {
    const res = spawnSync('bun', [MAIN_TS, 'mission', 'run', '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toContain('--state-dir');
  });

  it('`mission run` without --state-dir fails (required option enforced)', () => {
    const res = spawnSync('bun', [MAIN_TS, 'mission', 'run'], { encoding: 'utf8' });
    // Commander exits non-zero on a missing required option.
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('state-dir');
  });
});
