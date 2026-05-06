// Phase 13.3 — pure stall / no-op detector. Operates over a sliding
// window of TurnSummary records. Returns advisory-only result;
// callers decide whether/how to surface it. Never raises, never blocks.

export interface TurnSummary {
  fileEditCount: number;
  memoryWriteCount: number;
  /** Hard-coded 0 until decision-tracking infrastructure lands. */
  decisionCount: number;
  toolErrorCount: number;
}

export type StallResult = { stalled: false } | { stalled: true; reason: string };

const WINDOW = 3;

export function detectStall(turns: TurnSummary[]): StallResult {
  if (turns.length < WINDOW) return { stalled: false };
  const window = turns.slice(-WINDOW);

  const allEmpty = window.every(
    (t) =>
      t.fileEditCount === 0 &&
      t.memoryWriteCount === 0 &&
      t.decisionCount === 0 &&
      t.toolErrorCount === 0,
  );
  if (allEmpty) {
    return {
      stalled: true,
      reason: 'no edits, no decisions, no memory writes for 3 turns',
    };
  }

  const onlyErrors = window.every(
    (t) =>
      t.toolErrorCount > 0 &&
      t.fileEditCount === 0 &&
      t.memoryWriteCount === 0 &&
      t.decisionCount === 0,
  );
  if (onlyErrors) {
    return {
      stalled: true,
      reason: 'repeated tool errors with no progress for 3 turns',
    };
  }

  return { stalled: false };
}
