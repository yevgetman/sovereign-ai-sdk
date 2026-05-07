import { describe, expect, test } from 'bun:test';
import { contradict, reinforce, shouldPrune } from '../../src/learning/confidence.js';

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
