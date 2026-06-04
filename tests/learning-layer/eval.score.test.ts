// tests/learning-layer/eval.score.test.ts
import { describe, expect, test } from 'bun:test';
import {
  type ArmResult,
  type ScenarioScore,
  aggregateScenario,
  aggregateVerdict,
  scoreScenario,
  verdict,
} from '../../src/learning-layer/eval/score.js';

const arm = (passed: boolean, toolCalls: number): ArmResult => ({ passed, toolCalls });

/** Build one rep's score for a (without, with) pass pair. Tool calls are irrelevant to the
 *  flip/regression aggregation under test, so they're fixed. */
const rep = (withoutPassed: boolean, withPassed: boolean): ScenarioScore =>
  scoreScenario({ scenario: 's', without: arm(withoutPassed, 5), with: arm(withPassed, 4) });

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
  test('carries per-arm pass state for aggregation', () => {
    const r = scoreScenario({ scenario: 's', without: arm(false, 9), with: arm(true, 4) });
    expect(r.withoutPassed).toBe(false);
    expect(r.withPassed).toBe(true);
  });
});

describe('aggregateScenario (fold N reps into a per-scenario summary)', () => {
  test('3/3 flips -> robust flip, counts are raw', () => {
    const a = aggregateScenario('s', [rep(false, true), rep(false, true), rep(false, true)]);
    expect(a.reps).toBe(3);
    expect(a.flips).toBe(3);
    expect(a.regressions).toBe(0);
    expect(a.robustFlip).toBe(true);
    expect(a.withoutPasses).toBe(0);
    expect(a.withPasses).toBe(3);
  });

  test('2/3 flips -> NOT robust (fragility is not rounded up)', () => {
    // Rep 3: without passed AND with passed -> neither flip nor regression.
    const a = aggregateScenario('s', [rep(false, true), rep(false, true), rep(true, true)]);
    expect(a.flips).toBe(2);
    expect(a.regressions).toBe(0);
    expect(a.robustFlip).toBe(false);
    expect(a.withoutPasses).toBe(1);
    expect(a.withPasses).toBe(3);
  });

  test('1/3 flips -> NOT robust', () => {
    const a = aggregateScenario('s', [rep(false, true), rep(false, false), rep(false, false)]);
    expect(a.flips).toBe(1);
    expect(a.robustFlip).toBe(false);
  });

  test('any regression in any rep is counted', () => {
    // 2 reps flip, 1 rep regresses (without passed, with failed).
    const a = aggregateScenario('s', [rep(false, true), rep(false, true), rep(true, false)]);
    expect(a.flips).toBe(2);
    expect(a.regressions).toBe(1);
    // Still not robust: a 2/3 flip with a regression is doubly disqualified.
    expect(a.robustFlip).toBe(false);
  });

  test('zero reps -> not robust, no divide-by-zero in avg', () => {
    const a = aggregateScenario('s', []);
    expect(a.reps).toBe(0);
    expect(a.flips).toBe(0);
    expect(a.robustFlip).toBe(false);
    expect(a.avgEfficiencyDelta).toBe(0);
  });

  test('avgEfficiencyDelta is the mean tool-call savings across reps', () => {
    const reps = [
      scoreScenario({ scenario: 's', without: arm(false, 10), with: arm(true, 4) }), // +6
      scoreScenario({ scenario: 's', without: arm(false, 8), with: arm(true, 4) }), // +4
    ];
    const a = aggregateScenario('s', reps);
    expect(a.avgEfficiencyDelta).toBe(5);
  });
});

describe('aggregateVerdict (honest robust-flip bar over per-scenario aggregates)', () => {
  const robust = (name: string) =>
    aggregateScenario(name, [rep(false, true), rep(false, true), rep(false, true)]);
  const fragile2of3 = (name: string) =>
    aggregateScenario(name, [rep(false, true), rep(false, true), rep(true, true)]);

  test('PASS when >= minFlips robust flips and zero regressions', () => {
    const aggs = [robust('a'), robust('b'), robust('c'), fragile2of3('d')];
    const v = aggregateVerdict(aggs, { minFlips: 3 });
    expect(v.pass).toBe(true);
    expect(v.robustFlips).toBe(3);
    expect(v.totalRegressions).toBe(0);
  });

  test('fragile 2/3 flips do NOT count toward the bar', () => {
    // Three scenarios but only TWO are robust; the third flips 2/3.
    const aggs = [robust('a'), robust('b'), fragile2of3('c')];
    const v = aggregateVerdict(aggs, { minFlips: 3 });
    expect(v.robustFlips).toBe(2);
    expect(v.pass).toBe(false);
  });

  test('FAIL on any regression in any rep even if robust flips meet the bar', () => {
    const withRegression = aggregateScenario('r', [
      rep(false, true),
      rep(false, true),
      rep(true, false), // regression
    ]);
    const aggs = [robust('a'), robust('b'), robust('c'), withRegression];
    const v = aggregateVerdict(aggs, { minFlips: 3 });
    expect(v.robustFlips).toBe(3);
    expect(v.totalRegressions).toBe(1);
    expect(v.pass).toBe(false);
  });

  test('FAIL when robust flips below the bar', () => {
    const v = aggregateVerdict([robust('a'), robust('b')], { minFlips: 3 });
    expect(v.pass).toBe(false);
    expect(v.robustFlips).toBe(2);
  });

  test('empty aggregates -> not pass, zero counts', () => {
    const v = aggregateVerdict([], { minFlips: 3 });
    expect(v.pass).toBe(false);
    expect(v.robustFlips).toBe(0);
    expect(v.total).toBe(0);
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
