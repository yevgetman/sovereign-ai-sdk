// tests/learning-layer/eval.score.test.ts
import { describe, expect, test } from 'bun:test';
import { type ArmResult, scoreScenario, verdict } from '../../src/learning-layer/eval/score.js';

const arm = (passed: boolean, toolCalls: number): ArmResult => ({ passed, toolCalls });

describe('scoreScenario', () => {
  test('correctness flip = without fails AND with passes', () => {
    const r = scoreScenario({ scenario: 's', without: arm(false, 9), with: arm(true, 4) });
    expect(r.flip).toBe(true);
    expect(r.regression).toBe(false);
  });
  test('regression = with does worse (passed->failed)', () => {
    const r = scoreScenario({ scenario: 's', without: arm(true, 5), with: arm(false, 5) });
    expect(r.flip).toBe(false);
    expect(r.regression).toBe(true);
  });
  test('both pass -> efficiency delta reported, no flip', () => {
    const r = scoreScenario({ scenario: 's', without: arm(true, 8), with: arm(true, 5) });
    expect(r.flip).toBe(false);
    expect(r.efficiencyDelta).toBe(3);
  });
});

describe('verdict', () => {
  test('PASS when flips >= minFlips and no regressions', () => {
    const scores = [
      scoreScenario({ scenario: 'a', without: arm(false, 9), with: arm(true, 4) }),
      scoreScenario({ scenario: 'b', without: arm(false, 7), with: arm(true, 3) }),
      scoreScenario({ scenario: 'c', without: arm(false, 6), with: arm(true, 2) }),
      scoreScenario({ scenario: 'd', without: arm(true, 5), with: arm(true, 5) }),
    ];
    const v = verdict(scores, { minFlips: 3, repetitions: 1 });
    expect(v.pass).toBe(true);
    expect(v.flips).toBe(3);
  });
  test('FAIL on any regression even if flips meet the bar', () => {
    const scores = [
      scoreScenario({ scenario: 'a', without: arm(false, 9), with: arm(true, 4) }),
      scoreScenario({ scenario: 'b', without: arm(false, 7), with: arm(true, 3) }),
      scoreScenario({ scenario: 'c', without: arm(false, 6), with: arm(true, 2) }),
      scoreScenario({ scenario: 'r', without: arm(true, 5), with: arm(false, 5) }),
    ];
    const v = verdict(scores, { minFlips: 3, repetitions: 1 });
    expect(v.pass).toBe(false);
    expect(v.regressions).toBe(1);
  });
  test('FAIL when flips below the bar', () => {
    const scores = [scoreScenario({ scenario: 'a', without: arm(false, 9), with: arm(true, 4) })];
    expect(verdict(scores, { minFlips: 3, repetitions: 1 }).pass).toBe(false);
  });
});
