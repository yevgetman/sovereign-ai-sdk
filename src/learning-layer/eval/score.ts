// src/learning-layer/eval/score.ts — pure scorer for the with-vs-without learning eval: correctness flip + efficiency delta + PASS/FAIL verdict.

/** One arm's outcome for a scenario: did the task pass, and how many tool calls did it take. */
export interface ArmResult {
  readonly passed: boolean;
  readonly toolCalls: number;
}

/** A single scenario run as both arms: without-learning vs with-learning. */
export interface ScenarioInput {
  readonly scenario: string;
  readonly without: ArmResult;
  readonly with: ArmResult;
}

/** Per-scenario score: whether learning flipped the outcome, regressed it, and the tool-call savings. */
export interface ScenarioScore {
  readonly scenario: string;
  readonly flip: boolean;
  readonly regression: boolean;
  readonly efficiencyDelta: number;
}

/** Aggregate PASS/FAIL verdict across all scored scenarios. */
export interface Verdict {
  readonly pass: boolean;
  readonly flips: number;
  readonly regressions: number;
  readonly total: number;
}

/**
 * Score one scenario.
 * - flip: without fails AND with passes (the recalled lesson changed behavior for the better).
 * - regression: without passes AND with fails (the lesson made things worse).
 * - efficiencyDelta: without.toolCalls - with.toolCalls (positive means with-learning used fewer).
 */
export function scoreScenario(input: ScenarioInput): ScenarioScore {
  const withoutArm = input.without;
  const withArm = input.with;
  return {
    scenario: input.scenario,
    flip: !withoutArm.passed && withArm.passed,
    regression: withoutArm.passed && !withArm.passed,
    efficiencyDelta: withoutArm.toolCalls - withArm.toolCalls,
  };
}

/**
 * Aggregate a verdict over pre-scored scenarios.
 * PASS = flips >= minFlips AND no regressions. `repetitions` is carried by the caller for
 * reporting; the caller pre-aggregates repeated runs into the scores it passes here, so the
 * verdict stays a simple count over the given scores.
 */
export function verdict(
  scores: readonly ScenarioScore[],
  opts: { minFlips: number; repetitions: number },
): Verdict {
  const flips = scores.filter((s) => s.flip).length;
  const regressions = scores.filter((s) => s.regression).length;
  return {
    pass: flips >= opts.minFlips && regressions === 0,
    flips,
    regressions,
    total: scores.length,
  };
}
