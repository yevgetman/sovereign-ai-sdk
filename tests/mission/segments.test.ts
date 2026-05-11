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
  test('returns at least 3 segments (goal, state, and one more)', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    expect(segs.length).toBeGreaterThanOrEqual(3);
  });

  test('includes mission goal text in a cacheable segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const cacheableTexts = segs
      .filter((s) => s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(cacheableTexts).toContain('Repo Summary');
  });

  test('includes plan in a cacheable segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const cacheableTexts = segs
      .filter((s) => s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(cacheableTexts).toContain('Read README');
  });

  test('includes FSM state and wake count in a cacheable segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const cacheableTexts = segs
      .filter((s) => s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(cacheableTexts).toContain('active');
    expect(cacheableTexts).toContain('10');
  });

  test('notes.md goes into an ephemeral segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const ephemeralTexts = segs
      .filter((s) => !s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(ephemeralTexts).toContain('found the README');
  });

  test('wake log tail goes into an ephemeral segment', () => {
    const segs = buildMissionSegments(BASE_FILES, {});
    const ephemeralTexts = segs
      .filter((s) => !s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(ephemeralTexts).toContain('wake 1');
  });

  test('omits plan segment when plan is empty', () => {
    const segs = buildMissionSegments({ ...BASE_FILES, plan: '' }, {});
    const cacheableTexts = segs
      .filter((s) => s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(cacheableTexts).not.toContain('mission-plan');
  });

  test('omits notes segment when notes is empty', () => {
    const segs = buildMissionSegments({ ...BASE_FILES, notes: '' }, {});
    const ephemeralTexts = segs
      .filter((s) => !s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(ephemeralTexts).not.toContain('mission-notes');
  });

  test('omits wake log segment when recentWakeLog is empty', () => {
    const segs = buildMissionSegments({ ...BASE_FILES, recentWakeLog: [] }, {});
    const ephemeralTexts = segs
      .filter((s) => !s.cacheable)
      .map((s) => s.text)
      .join('\n');
    expect(ephemeralTexts).not.toContain('wake-log-tail');
  });

  test('cacheEnabled:false marks all segments non-cacheable', () => {
    const segs = buildMissionSegments(BASE_FILES, { cacheEnabled: false });
    expect(segs.every((s) => !s.cacheable)).toBe(true);
  });
});
