import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lockPath,
  missionMdPath,
  notesMdPath,
  planMdPath,
  stateJsonPath,
  wakeLogPath,
} from '../../src/mission/paths.js';
import {
  acquireLock,
  appendWakeLog,
  loadMissionState,
  releaseLock,
  writeMissionState,
} from '../../src/mission/state.js';
import type { MissionFsmState, MissionStateJson, WakeLogEntry } from '../../src/mission/types.js';

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
    writeFileSync(
      join(dir, 'wake_log.jsonl'),
      `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );

    const files = loadMissionState(dir);
    expect(files.recentWakeLog).toHaveLength(5);
    expect(files.recentWakeLog[0]?.wakeNumber).toBe(3);
    expect(files.recentWakeLog[4]?.wakeNumber).toBe(7);
  });

  test('skips malformed lines in wake_log.jsonl without discarding good entries', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));
    const goodEntry: WakeLogEntry = {
      wakeNumber: 1,
      timestamp: '2026-05-11T00:00:00.000Z',
      fsmStateBefore: 'active',
      fsmStateAfter: 'active',
      durationMs: 1000,
    };
    writeFileSync(
      join(dir, 'wake_log.jsonl'),
      `${JSON.stringify(goodEntry)}\nNOT_JSON\n${JSON.stringify({ ...goodEntry, wakeNumber: 2 })}\n`,
    );
    const files = loadMissionState(dir);
    expect(files.recentWakeLog).toHaveLength(2);
    expect(files.recentWakeLog[0]?.wakeNumber).toBe(1);
    expect(files.recentWakeLog[1]?.wakeNumber).toBe(2);
  });
});

describe('writeMissionState', () => {
  test('patches state.json atomically', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));

    writeMissionState(dir, {
      fsmState: 'active',
      wakeCount: 1,
      updatedAt: '2026-05-11T01:00:00.000Z',
    });
    const files = loadMissionState(dir);
    expect(files.state.fsmState).toBe('active');
    expect(files.state.wakeCount).toBe(1);
    expect(files.state.goal).toBe(VALID_STATE.goal);
  });

  test('throws on invalid fsmState in patch', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));
    expect(() => writeMissionState(dir, { fsmState: 'bogus' as MissionFsmState })).toThrow(
      /invalid fsmState/,
    );
  });
});

describe('appendWakeLog', () => {
  test('appends JSONL entries to wake_log.jsonl', () => {
    const dir = makeTestDir();
    writeFileSync(join(dir, 'mission.md'), '# Test');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(VALID_STATE));

    const entry: WakeLogEntry = {
      wakeNumber: 1,
      timestamp: '2026-05-11T00:00:00.000Z',
      fsmStateBefore: 'planning',
      fsmStateAfter: 'active',
      durationMs: 1200,
    };
    appendWakeLog(dir, entry);
    appendWakeLog(dir, { ...entry, wakeNumber: 2 });

    const files = loadMissionState(dir);
    expect(files.recentWakeLog).toHaveLength(2);
    expect(files.recentWakeLog[0]?.wakeNumber).toBe(1);
    expect(files.recentWakeLog[1]?.wakeNumber).toBe(2);
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
