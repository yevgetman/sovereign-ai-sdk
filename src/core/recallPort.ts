// src/core/recallPort.ts — open-core Recall output types.
//
// `RecallResult` is the return type of `RecallTurn` (see ./types.ts), so it and
// its minimal closure (`RecalledLesson`) live in the open core. The proprietary
// learning layer re-exports them, inverting the dependency so open core never
// imports from proprietary code.

/** A single lesson the layer chose to surface (Recall output, for tracing/eval). */
export interface RecalledLesson {
  readonly id: string;
  readonly trigger: string;
  readonly action: string;
  readonly confidence: number;
}

/** What the layer hands back to inject in front of the agent (Recall output). */
export interface RecallResult {
  /** Fenced, ready-to-inject text; empty string when nothing is relevant. */
  readonly injectionText: string;
  /** Structured provenance; never required by the host to act. */
  readonly lessons: readonly RecalledLesson[];
}
