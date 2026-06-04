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
  /** Whether the without-learning arm passed this run (carried for per-arm pass-rate aggregation). */
  readonly withoutPassed: boolean;
  /** Whether the with-learning arm passed this run (carried for per-arm pass-rate aggregation). */
  readonly withPassed: boolean;
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
    withoutPassed: withoutArm.passed,
    withPassed: withArm.passed,
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

/**
 * Per-scenario summary folded over N repeated runs. LLM output is stochastic, so a single
 * run's flip is suggestive but not statistical: running each arm N times and counting how
 * often the flip reproduces exposes fragility a single run would hide. Counts are raw
 * (out of `reps`) so a 2/3 or 1/3 flip is visible and NOT rounded up to a pass.
 */
export interface ScenarioAggregate {
  readonly scenario: string;
  /** Number of repetitions folded into this aggregate. */
  readonly reps: number;
  /** Reps where the without-learning arm passed. */
  readonly withoutPasses: number;
  /** Reps where the with-learning arm passed. */
  readonly withPasses: number;
  /** Reps where the recalled lesson flipped the outcome (without failed AND with passed). */
  readonly flips: number;
  /** Reps where the lesson regressed the outcome (without passed AND with failed). */
  readonly regressions: number;
  /**
   * A scenario is a ROBUST flip only when it flips in EVERY rep (flips === reps, reps > 0).
   * Anything less (2/3, 1/3) is fragile and must be reported as such, never counted as robust.
   */
  readonly robustFlip: boolean;
  /** Mean tool-call savings across reps (without - with). Reporting-only; not a gate. */
  readonly avgEfficiencyDelta: number;
}

/**
 * Fold N per-rep scores for one scenario into a single aggregate.
 * - flips / regressions: raw counts of reps exhibiting each outcome.
 * - robustFlip: true ONLY when the scenario flipped in all reps (flips === reps, reps > 0) —
 *   the honest bar that prevents a fragile 2/3 scenario from being treated as a clean win.
 * Pure over its inputs.
 */
export function aggregateScenario(
  scenario: string,
  reps: readonly ScenarioScore[],
): ScenarioAggregate {
  const repCount = reps.length;
  const flips = reps.filter((r) => r.flip).length;
  const regressions = reps.filter((r) => r.regression).length;
  const totalDelta = reps.reduce((sum, r) => sum + r.efficiencyDelta, 0);
  return {
    scenario,
    reps: repCount,
    withoutPasses: reps.filter((r) => r.withoutPassed).length,
    withPasses: reps.filter((r) => r.withPassed).length,
    flips,
    regressions,
    robustFlip: repCount > 0 && flips === repCount,
    avgEfficiencyDelta: repCount > 0 ? totalDelta / repCount : 0,
  };
}

/** Aggregate PASS/FAIL verdict folded over per-scenario aggregates. */
export interface AggregateVerdict {
  readonly pass: boolean;
  /** Scenarios that flipped in EVERY rep (robust). The bar counts only these. */
  readonly robustFlips: number;
  /** Total regressions across every rep of every scenario — any one fails the run. */
  readonly totalRegressions: number;
  /** Total scenarios aggregated. */
  readonly total: number;
}

/**
 * Aggregate a verdict over per-scenario aggregates, honestly.
 * PASS = at least `minFlips` scenarios are ROBUST flips (flipped in all reps) AND zero
 * regressions in any rep of any scenario. A scenario that flips only 2/3 does NOT count
 * toward the bar — fragility is surfaced, never rounded up.
 */
export function aggregateVerdict(
  aggregates: readonly ScenarioAggregate[],
  opts: { minFlips: number },
): AggregateVerdict {
  const robustFlips = aggregates.filter((a) => a.robustFlip).length;
  const totalRegressions = aggregates.reduce((sum, a) => sum + a.regressions, 0);
  return {
    pass: robustFlips >= opts.minFlips && totalRegressions === 0,
    robustFlips,
    totalRegressions,
    total: aggregates.length,
  };
}
