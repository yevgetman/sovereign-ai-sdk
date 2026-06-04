// tests/learning-layer/recall.assemble.test.ts
import { describe, expect, test } from 'bun:test';
import { assembleLessons } from '../../src/learning-layer/recall/assemble.js';
import type { Instinct } from '../../src/learning/types.js';

const inst = (id: string, trigger: string, confidence: number): Instinct =>
  ({
    id,
    trigger,
    action: `do-${id}`,
    confidence,
    evidence_count: 6,
    domain: 'testing',
    scope: 'project',
    project_id: 'p',
    project_name: 'd',
    created_at: '2026-06-03T00:00:00.000Z',
    last_evidence_at: '2026-06-03T00:00:00.000Z',
    observation_ids: [],
  }) as Instinct;

describe('assembleLessons', () => {
  const instincts = [
    inst('tests', 'running the test suite', 0.4),
    inst('deploy', 'deploying to production', 0.9),
    inst('tests2', 'run tests before commit', 0.5),
  ];
  test('surfaces trigger-relevant lessons, sorted by (relevance, confidence)', () => {
    const out = assembleLessons({
      instincts,
      latestUserText: 'please run the tests',
      maxLessons: 8,
      tokenBudget: 1000,
    });
    const ids = out.map((l) => l.id);
    expect(ids).toContain('tests');
    expect(ids).toContain('tests2');
    expect(ids).not.toContain('deploy'); // irrelevant trigger dropped
  });
  test('empty/undefined user text -> no lessons', () => {
    expect(
      assembleLessons({ instincts, latestUserText: undefined, maxLessons: 8, tokenBudget: 1000 }),
    ).toEqual([]);
  });
  test('respects maxLessons and tokenBudget', () => {
    const out = assembleLessons({
      instincts,
      latestUserText: 'run the tests',
      maxLessons: 1,
      tokenBudget: 1000,
    });
    expect(out).toHaveLength(1);
    const tiny = assembleLessons({
      instincts,
      latestUserText: 'run the tests',
      maxLessons: 8,
      tokenBudget: 1,
    });
    expect(tiny).toHaveLength(0); // nothing fits the budget
  });
});
