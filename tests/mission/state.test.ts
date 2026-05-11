import { describe, expect, test } from 'bun:test';
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
