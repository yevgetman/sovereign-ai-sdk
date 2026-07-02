// Phase 10.5 part 2b — replay fixture format. A fixture captures every
// StreamEvent the provider yielded plus every tool result the
// orchestrator received during a live run. Replaying the fixture
// against the same agent code path with `ReplayProvider` +
// `wrapToolsForReplay` produces a deterministic re-run — useful for
// CI assertions and regression bisection without spending tokens.
//
// Fidelity goal: byte-for-byte stream events and identical tool
// results. Provider request bodies are NOT captured (their content is
// derived from the prior turn's history); only what the provider
// produced + what the tools produced.

import type { StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { ToolObservation } from '@yevgetman/sov-sdk/tool/types';

/** Result captured from a real `tool.call()` invocation. The wrapper's
 *  job at replay time is to return this exactly (or throw the captured
 *  error), keying off (toolName, callIndex). */
export type ReplayToolResult = {
  /** The tool that produced this result. */
  toolName: string;
  /** Zero-based index of this call WITHIN its tool name. The first call
   *  to Read is 0, the second is 1, etc. — independent of turn boundaries. */
  callIndex: number;
  /** The data returned by tool.call(). Keyed verbatim. */
  data: unknown;
  /** Optional observation envelope (Phase 12.5). */
  observation?: ToolObservation;
  /** When set, the wrapper throws an Error with this message instead
   *  of returning data. Captures `tool threw: …` cases. */
  error?: string;
};

/** Everything that happened in one provider.stream() call. */
export type ReplayTurn = {
  /** Zero-based turn number. */
  turn: number;
  /** Every StreamEvent yielded by provider.stream(), in order.
   *  Includes message_start, deltas, usage_delta, message_stop, and
   *  the terminal assistant_message. */
  providerEvents: StreamEvent[];
  /** Tool results produced inside this turn (those captured from the
   *  orchestrator running the tool_use blocks emitted by the assistant
   *  message at the end of providerEvents). */
  toolResults: ReplayToolResult[];
};

/** Top-level fixture record. Stored as JSON (one object) or as JSONL
 *  with one object per turn — the loader supports both. */
export type ReplayFixture = {
  meta: {
    /** Source session id (informational; replay creates fresh ids). */
    sessionId: string;
    provider: string;
    model: string;
    /** ISO timestamp of capture. */
    capturedAt: string;
  };
  turns: ReplayTurn[];
};
