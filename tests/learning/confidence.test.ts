import { describe, expect, test } from 'bun:test';
import {
  confidenceFromEvidence,
  contradict,
  reinforce,
  shouldPrune,
} from '../../src/learning/confidence.js';

describe('reinforce', () => {
  test('zero or negative evidence is a no-op (returns current rounded)', () => {
    expect(reinforce(0.5, 0)).toBe(0.5);
    expect(reinforce(0.5, -1)).toBe(0.5);
  });

  test('positive evidence increases confidence', () => {
    const next = reinforce(0.3, 1);
    expect(next).toBeGreaterThan(0.3);
  });

  test('logarithmic — 10 single-evidence calls outpace 1 ten-evidence call', () => {
    // Ten separate +1 events accumulate more than one +10 event because
    // log(1+1) summed 10 times > log(1+10).
    let acc = 0;
    for (let i = 0; i < 10; i++) acc = reinforce(acc, 1);
    const single = reinforce(0, 10);
    expect(acc).toBeGreaterThan(single);
  });

  test('caps at 0.9 even with massive evidence', () => {
    const next = reinforce(0.85, 1_000_000);
    expect(next).toBe(0.9);
  });

  test('starting at 0.9 stays at 0.9', () => {
    expect(reinforce(0.9, 100)).toBe(0.9);
  });

  test('rounds to 3 decimal places', () => {
    const result = reinforce(0.5, 1);
    // result is a finite number with at most 3 decimals after rounding
    expect(result.toString()).toMatch(/^\d+(\.\d{1,3})?$/);
  });
});

describe('confidenceFromEvidence', () => {
  test('zero evidence -> 0', () => expect(confidenceFromEvidence(0)).toBe(0));
  test('negative evidence -> 0', () => expect(confidenceFromEvidence(-3)).toBe(0));
  test('~6 obs clears the 0.3 prune floor', () =>
    expect(confidenceFromEvidence(6)).toBeGreaterThanOrEqual(0.3));
  test('~20 obs clears the 0.7 promotion gate', () =>
    expect(confidenceFromEvidence(20)).toBeGreaterThanOrEqual(0.7));
  test('monotonic increasing', () =>
    expect(confidenceFromEvidence(10)).toBeGreaterThan(confidenceFromEvidence(5)));
  test('never reaches the cap', () => expect(confidenceFromEvidence(100000)).toBeLessThan(0.9));

  test('exact value at the documented saturation scale', () => {
    // 0.9 * (1 - exp(-13/13)) rounded to 3 places.
    expect(confidenceFromEvidence(13)).toBe(0.569);
  });

  test('respects a custom confidenceCap', () => {
    // Lower cap shrinks every output proportionally.
    const capped = confidenceFromEvidence(20, { confidenceCap: 0.5 });
    expect(capped).toBeLessThan(confidenceFromEvidence(20));
    expect(capped).toBeLessThan(0.5);
  });

  test('respects a custom evidenceSaturation (smaller tau ramps faster)', () => {
    const fast = confidenceFromEvidence(6, { evidenceSaturation: 6 });
    const slow = confidenceFromEvidence(6, { evidenceSaturation: 26 });
    expect(fast).toBeGreaterThan(slow);
  });

  test('omitted tuning preserves default behavior', () => {
    expect(confidenceFromEvidence(6)).toBe(confidenceFromEvidence(6, {}));
  });
});

describe('contradict', () => {
  test('drops by 0.2 per unit weight', () => {
    expect(contradict(0.6, 1)).toBe(0.4);
    expect(contradict(0.6, 2)).toBe(0.2);
  });

  test('default weight is 1', () => {
    expect(contradict(0.6)).toBe(0.4);
  });

  test('floors at 0', () => {
    expect(contradict(0.1, 1)).toBe(0);
    expect(contradict(0.5, 5)).toBe(0);
  });

  test('rounds to 3 decimal places', () => {
    const result = contradict(0.523, 1);
    expect(result).toBe(0.323);
  });
});

describe('reinforce — tunable', () => {
  test('custom reinforcementCurveK accelerates the curve', () => {
    const defaultK = reinforce(0, 5);
    const fastK = reinforce(0, 5, { reinforcementCurveK: 0.15 });
    expect(fastK).toBeGreaterThan(defaultK);
  });

  test('initialConfidenceBaseline bumps the starting floor', () => {
    const noFloor = reinforce(0, 5);
    const withFloor = reinforce(0, 5, { initialConfidenceBaseline: 0.4 });
    // With floor=0.4, startFrom = max(0, 0.4) = 0.4, then +log curve.
    // Without floor, startFrom = 0, then +log curve.
    expect(withFloor).toBeGreaterThan(noFloor + 0.3);
  });

  test('initialConfidenceBaseline is a floor, not an override', () => {
    // currentConfidence already above baseline → no change from baseline.
    const noBaseline = reinforce(0.6, 3);
    const withBaseline = reinforce(0.6, 3, { initialConfidenceBaseline: 0.4 });
    expect(withBaseline).toBe(noBaseline);
  });

  test('confidenceCap respected when set below default', () => {
    expect(reinforce(0.85, 1_000_000, { confidenceCap: 0.8 })).toBe(0.8);
  });

  test('omitted tuning preserves default behavior', () => {
    // Smoke-check: reinforce(0, 5) returns the same value with or without {}.
    const a = reinforce(0, 5);
    const b = reinforce(0, 5, {});
    expect(a).toBe(b);
  });
});

describe('contradict — tunable', () => {
  test('custom contradictionDelta', () => {
    expect(contradict(0.5, 1, { contradictionDelta: -0.4 })).toBe(0.1);
  });

  test('omitted tuning preserves default behavior', () => {
    const a = contradict(0.6, 1);
    const b = contradict(0.6, 1, {});
    expect(a).toBe(b);
  });
});

describe('shouldPrune', () => {
  test('returns false when confidence is at or above threshold', () => {
    const oldTs = new Date(Date.now() - 365 * 86_400_000).toISOString();
    expect(shouldPrune(0.5, oldTs, 0.3, 30)).toBe(false);
    expect(shouldPrune(0.3, oldTs, 0.3, 30)).toBe(false);
  });

  test('returns false when below threshold but within aging window', () => {
    const recentTs = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(shouldPrune(0.2, recentTs, 0.3, 30)).toBe(false);
  });

  test('returns true when below threshold AND past aging window', () => {
    const oldTs = new Date(Date.now() - 60 * 86_400_000).toISOString();
    expect(shouldPrune(0.2, oldTs, 0.3, 30)).toBe(true);
  });

  test('returns false on malformed lastEvidenceAt (cannot reason)', () => {
    expect(shouldPrune(0.2, 'not-a-date', 0.3, 30)).toBe(false);
  });
});
