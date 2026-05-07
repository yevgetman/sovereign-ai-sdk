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

const CONFIDENCE_CAP = 0.9;
const CONFIDENCE_FLOOR = 0;
const REINFORCEMENT_K = 0.04; // tunable; logarithmic
const CONTRADICTION_DELTA = -0.2;

/** Logarithmic reinforcement; bounded at CONFIDENCE_CAP. The curve
 *  decelerates as confidence approaches 0.9 — a 0.5→0.55 jump is harder
 *  than 0.3→0.35. evidenceCount is the number of NEW supporting
 *  observations since the last update. */
export function reinforce(currentConfidence: number, evidenceCount: number): number {
  if (evidenceCount <= 0) return roundTo(currentConfidence, 3);
  const delta = REINFORCEMENT_K * Math.log(1 + evidenceCount);
  const next = Math.min(currentConfidence + delta, CONFIDENCE_CAP);
  return roundTo(next, 3);
}

/** Sharp contradiction drop. Floor at 0. contradictionWeight is a
 *  multiplier (e.g., 1 for one rejection, 2 for repeated rejection). */
export function contradict(currentConfidence: number, contradictionWeight = 1): number {
  const next = Math.max(
    currentConfidence + CONTRADICTION_DELTA * contradictionWeight,
    CONFIDENCE_FLOOR,
  );
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
