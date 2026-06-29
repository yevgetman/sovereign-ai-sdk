// src/core/sessionPort.ts — open-core session DTOs.
//
// These are the pure session-shape types the open command contract
// (`commands/types.ts` → `CommandContext`) references, relocated here so the
// open contract never imports the proprietary `agent/sessionDb.ts` (the
// `bun:sqlite` impl) or the wrapper `ui/sessionSummary.ts`. Those modules
// re-export them, inverting the dependency — the same pattern
// `core/taskPort.ts` / `core/observePort.ts` use. Pure leaves: only primitives
// and nested records, no internal `src/` dependencies.

/** Per-session token + cost accounting (chat + compaction lanes). */
export type SessionCost = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostUsd: number;
  compactionInputTokens: number;
  compactionOutputTokens: number;
  estimatedCompactionCostUsd: number;
};

/** One row in the session list (newest-first), as surfaced by `/resume`. */
export type SessionListEntry = {
  sessionId: string;
  parentSessionId: string | null;
  model: string;
  provider: string;
  platform: string;
  createdAt: number;
  lastUpdated: number;
  /** Stored title if present, else the first user message (truncated). */
  title: string | null;
  /** Phase E — owning principal id, or null for unowned rows. */
  ownerId: string | null;
  /** Number of messages in the session. */
  msgCount: number;
  /** Total tokens (chat + cache + compaction lanes summed). */
  totalTokens: number;
  /** Total estimated cost (chat + compaction lanes summed). */
  totalCostUsd: number;
};

/** Session-end (and mid-session `/stats`) metrics card shape. */
export type SessionMetrics = {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  agentActiveMs: number;
  apiTimeMs: number;
  toolTimeMs: number;
  toolCalls: number;
  toolOk: number;
  toolErr: number;
  /** Cumulative token usage for the session (chat + compaction lanes
   *  combined). Populated from sessionDb.getSessionCost just before the
   *  summary renders. */
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    estimatedCostUsd: number;
  };
  /** Phase 13.3 (B3) — count of review-fork dispatches that happened
   *  during the session. Rendered as a "Reviews" section when nonzero. */
  reviews?: {
    totalDispatched: number;
    byAgent: Record<string, number>;
  };
};
