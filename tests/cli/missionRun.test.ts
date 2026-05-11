// Phase 16.0b — verifies runMissionWake() is callable headlessly given a
// pre-initialized mission directory and that it respects the overlap lock.

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMissionInit } from '../../src/cli/missionInit.js';
import { runMissionWake } from '../../src/cli/missionRun.js';

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

      // Create the lock directory manually to simulate an in-flight wake.
      mkdirSync(join(dir, '.lock'));

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
