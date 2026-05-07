import { describe, expect, test } from 'bun:test';
import { findPromotionCandidates } from '../../src/learning/promotion.js';
import type { Instinct } from '../../src/learning/types.js';

function inst(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: 'i-1',
    trigger: 't',
    action: 'a',
    confidence: 0.8,
    evidence_count: 5,
    domain: 'code-style',
    scope: 'project',
    project_id: 'projA',
    project_name: 'A',
    created_at: '2026-05-06T00:00:00Z',
    last_evidence_at: '2026-05-06T00:00:00Z',
    observation_ids: [],
    ...overrides,
  };
}

describe('findPromotionCandidates', () => {
  test('returns empty array when no instincts', () => {
    expect(findPromotionCandidates([])).toEqual([]);
  });

  test('matching trigger+action across 2 projects → 1 candidate', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA' }),
      inst({ id: 'i2', project_id: 'projB' }),
    ];
    const candidates = findPromotionCandidates(instincts);
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.trigger).toBe('t');
    expect(candidates[0]?.action).toBe('a');
    expect(candidates[0]?.evidenceProjects.length).toBe(2);
  });

  test('single-project instinct alone → 0 candidates', () => {
    expect(findPromotionCandidates([inst({ project_id: 'projA' })])).toEqual([]);
  });

  test('sub-threshold confidence excluded', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA', confidence: 0.5 }),
      inst({ id: 'i2', project_id: 'projB', confidence: 0.6 }),
    ];
    expect(findPromotionCandidates(instincts)).toEqual([]);
  });

  test('different domains do NOT match (semantic separation)', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA', domain: 'code-style' }),
      inst({ id: 'i2', project_id: 'projB', domain: 'testing' }),
    ];
    expect(findPromotionCandidates(instincts)).toEqual([]);
  });

  test('global-scoped instincts excluded from candidate pool', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA' }),
      inst({ id: 'i2', project_id: null, scope: 'global' }),
      inst({ id: 'i3', project_id: 'projB' }),
    ];
    const candidates = findPromotionCandidates(instincts);
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.evidenceProjects.length).toBe(2); // global excluded
  });

  test('three projects with same trigger/action → all surfaced as evidenceProjects', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA', evidence_count: 5 }),
      inst({ id: 'i2', project_id: 'projB', evidence_count: 3 }),
      inst({ id: 'i3', project_id: 'projC', evidence_count: 7 }),
    ];
    const candidates = findPromotionCandidates(instincts);
    expect(candidates.length).toBe(1);
    const projectIds = candidates[0]?.evidenceProjects.map((p) => p.projectId).sort();
    expect(projectIds).toEqual(['projA', 'projB', 'projC']);
  });

  test('custom thresholds: minProjects=3 raises the bar', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA' }),
      inst({ id: 'i2', project_id: 'projB' }),
    ];
    expect(findPromotionCandidates(instincts, { minProjects: 3 })).toEqual([]);
  });

  test('custom thresholds: minConfidence=0.5 widens the pool', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA', confidence: 0.5 }),
      inst({ id: 'i2', project_id: 'projB', confidence: 0.55 }),
    ];
    const candidates = findPromotionCandidates(instincts, { minConfidence: 0.5 });
    expect(candidates.length).toBe(1);
  });

  test('sorts by total evidence descending', () => {
    const lower = [
      inst({ id: 'low1', project_id: 'projA', trigger: 'low', evidence_count: 2 }),
      inst({ id: 'low2', project_id: 'projB', trigger: 'low', evidence_count: 2 }),
    ];
    const higher = [
      inst({ id: 'hi1', project_id: 'projA', trigger: 'hi', evidence_count: 10 }),
      inst({ id: 'hi2', project_id: 'projB', trigger: 'hi', evidence_count: 8 }),
    ];
    const candidates = findPromotionCandidates([...lower, ...higher]);
    expect(candidates[0]?.trigger).toBe('hi'); // total 18
    expect(candidates[1]?.trigger).toBe('low'); // total 4
  });

  test('per-project aggregation picks highest confidence on duplicate (rare race)', () => {
    const instincts = [
      inst({ id: 'i1', project_id: 'projA', confidence: 0.7 }),
      inst({ id: 'i2', project_id: 'projA', confidence: 0.85 }), // same project, higher confidence
      inst({ id: 'i3', project_id: 'projB', confidence: 0.75 }),
    ];
    const candidates = findPromotionCandidates(instincts);
    expect(candidates.length).toBe(1);
    const projA = candidates[0]?.evidenceProjects.find((p) => p.projectId === 'projA');
    expect(projA?.confidence).toBe(0.85);
  });
});
