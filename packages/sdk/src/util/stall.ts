// Phase 13.3 — pure stall / no-op detector. Operates over a sliding
// window of TurnSummary records. Returns advisory-only result;
// callers decide whether/how to surface it. Never raises, never blocks.
//
// ux-fixes round 2 — added toolCallCount so research-only turns
// (FileRead/Bash/Grep without edits/memory writes) count as progress.
// Previously the detector only counted file edits, memory writes,
// decisions, and errors, so a model spending 3 turns exploring the
// codebase via read-only tool calls got flagged as stalled — visible
// in the user's transcript as a spurious "stalled" warning right
// next to a fresh batch of completed tool cards.

export interface TurnSummary {
  fileEditCount: number;
  memoryWriteCount: number;
  /** Hard-coded 0 until decision-tracking infrastructure lands. */
  decisionCount: number;
  toolErrorCount: number;
  /**
   * Total tool_use blocks the assistant emitted this turn (including
   * the ones that errored). Any non-zero value counts as progress
   * because exploration tools (FileRead, Bash, Grep, FileSearch, ...)
   * advance the model's understanding even when nothing gets edited.
   * ux-fixes round 2.
   */
  toolCallCount: number;
}

export type StallResult = { stalled: false } | { stalled: true; reason: string };

const WINDOW = 3;

export function detectStall(turns: TurnSummary[]): StallResult {
  if (turns.length < WINDOW) return { stalled: false };
  const window = turns.slice(-WINDOW);

  // "All empty" = no tool calls AND no edits/memory/decisions for the
  // whole window. Research-only turns (toolCallCount > 0) are
  // explicitly NOT empty here per ux-fixes round 2.
  const allEmpty = window.every(
    (t) =>
      t.toolCallCount === 0 &&
      t.fileEditCount === 0 &&
      t.memoryWriteCount === 0 &&
      t.decisionCount === 0,
  );
  if (allEmpty) {
    return {
      stalled: true,
      reason: 'no tool calls, no edits, no decisions, no memory writes for 3 turns',
    };
  }

  // "Only errors" = every turn made tool calls but every call errored
  // AND no productive side-effects landed. Tracks the "infinite
  // failing retry" loop. Requires toolCallCount === toolErrorCount
  // (no successful calls), not just toolErrorCount > 0.
  const onlyErrors = window.every(
    (t) =>
      t.toolCallCount > 0 &&
      t.toolCallCount === t.toolErrorCount &&
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
