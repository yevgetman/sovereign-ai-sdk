// src/learning/confidence.ts
// Phase 13.4 — pure confidence-update math. No I/O.
//
// Reinforcement: logarithmic, capped at 0.9 (we never reach 1.0 — the
// world keeps changing and certainty would be unwarranted).
//
// Contradiction: sharp drop (−0.2 per contradiction unit), floor 0.
//
// shouldPrune: combines a sub-threshold confidence floor with an aging
// window — sub-threshold instincts past their no-reinforcement window
// get dropped by `harness learning prune`.
//
// Backlog Item 6 (P1): the constants below are the floor when no tuning
// is passed. Callers may override per-call via the optional
// `ConfidenceTuning` parameter. settings.learning.* surfaces these
// knobs to operators without code changes — see src/config/schema.ts.
// DO NOT change defaults aggressively; soak data should drive that.

const DEFAULT_CONFIDENCE_CAP = 0.9;
const CONFIDENCE_FLOOR = 0;
const DEFAULT_REINFORCEMENT_K = 0.04; // tunable; logarithmic
const DEFAULT_CONTRADICTION_DELTA = -0.2;

export interface ConfidenceTuning {
  /** Logarithmic reinforcement coefficient. Higher = faster ramp.
   *  Default 0.04 — produces ~0.10 confidence after 1 reinforce(0, 12).
   *  Tune via settings.learning.reinforcementCurveK. */
  reinforcementCurveK?: number;
  /** Sharp contradiction drop per unit weight. Default −0.2.
   *  Must be ≤ 0 (a positive value would make contradiction reinforce). */
  contradictionDelta?: number;
  /** Confidence ceiling. Default 0.9 (we never reach 1.0). */
  confidenceCap?: number;
  /** Floor under reinforce input — when set, reinforce(currentConfidence)
   *  treats currentConfidence as max(currentConfidence, baseline) before
   *  applying the curve. Effectively bumps the starting floor for new
   *  instincts. Default unset = pure reinforce from current. */
  initialConfidenceBaseline?: number;
}

/** Logarithmic reinforcement; bounded at the configured cap. The curve
 *  decelerates as confidence approaches the cap — a 0.5→0.55 jump is
 *  harder than 0.3→0.35. evidenceCount is the number of NEW supporting
 *  observations since the last update. */
export function reinforce(
  currentConfidence: number,
  evidenceCount: number,
  tuning?: ConfidenceTuning,
): number {
  if (evidenceCount <= 0) return roundTo(currentConfidence, 3);
  const k = tuning?.reinforcementCurveK ?? DEFAULT_REINFORCEMENT_K;
  const cap = tuning?.confidenceCap ?? DEFAULT_CONFIDENCE_CAP;
  const baseline = tuning?.initialConfidenceBaseline ?? 0;
  const startFrom = Math.max(currentConfidence, baseline);
  const delta = k * Math.log(1 + evidenceCount);
  const next = Math.min(startFrom + delta, cap);
  return roundTo(next, 3);
}

/** Sharp contradiction drop. Floor at 0. contradictionWeight is a
 *  multiplier (e.g., 1 for one rejection, 2 for repeated rejection). */
export function contradict(
  currentConfidence: number,
  contradictionWeight = 1,
  tuning?: ConfidenceTuning,
): number {
  const deltaPerUnit = tuning?.contradictionDelta ?? DEFAULT_CONTRADICTION_DELTA;
  const next = Math.max(currentConfidence + deltaPerUnit * contradictionWeight, CONFIDENCE_FLOOR);
  return roundTo(next, 3);
}

/** Whether an instinct should be pruned: sub-threshold AND past the
 *  aging window (no reinforcement in `pruneAgeDays` days). Both
 *  conditions must hold. */
export function shouldPrune(
  confidence: number,
  lastEvidenceAt: string,
  pruneBelowConfidence: number,
  pruneAgeDays: number,
): boolean {
  if (confidence >= pruneBelowConfidence) return false;
  const lastTs = new Date(lastEvidenceAt).getTime();
  if (Number.isNaN(lastTs)) return false; // can't reason about malformed timestamps
  const ageMs = Date.now() - lastTs;
  return ageMs > pruneAgeDays * 86_400_000;
}

function roundTo(n: number, places: number): number {
  const m = 10 ** places;
  return Math.round(n * m) / m;
}
