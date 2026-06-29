// src/core/compactPort.ts — open-core compaction result DTO.
//
// `CompactResult` is the pure result shape the open command contract
// (`CommandContext.compact: () => Promise<CompactResult>`) references. Relocated
// here so the open contract never imports the proprietary `compact/compactor.ts`
// (the compactor mints a child session + calls the auxiliary summarizer).
// `compactor.ts` re-exports it, inverting the dependency. References only the
// open `core/types.ts` `Message`.

import type { Message } from './types.js';

export type CompactResult = {
  parentSessionId: string;
  newSessionId: string;
  summary: string;
  tail: Message[];
  compactedMessages: number;
  estimatedBeforeTokens: number;
  estimatedAfterTokens: number;
  usedAuxiliary: boolean;
  auxiliaryProvider?: string;
  auxiliaryModel?: string;
  /** Backlog #36: true when compactSession short-circuited because the
   *  entire history fit within the tail budget — `head` was empty so there
   *  was nothing meaningful to summarize. The pre-fix behavior still ran
   *  the summarizer + minted a child session, producing
   *  `estimatedAfterTokens > estimatedBeforeTokens` (after = before +
   *  summary-message overhead) which the TUI surfaced as a misleading
   *  "auto-compacted — 2247→2318 tokens" marker. The fix returns a no-op
   *  result with `parentSessionId === newSessionId`, the original history
   *  echoed as `tail`, and `noOp: true` so callers can suppress the SSE
   *  marker (proactive/recovery), the session-id pivot (TUI), and the
   *  compaction-summary visual artifact. The flag is OPTIONAL — happy-path
   *  results omit it (callers that don't check it continue working). */
  noOp?: boolean;
};
