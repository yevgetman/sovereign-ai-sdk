// src/core/sessionPort.ts — open-core session DTOs.
//
// These are the pure session-shape types the open command contract
// (`commands/types.ts` → `CommandContext`) and the open `SessionStore` port
// (`persistence/sessionStore.ts`) reference, relocated here so neither imports
// the proprietary `agent/sessionDb.ts` (the `bun:sqlite` impl) or the wrapper
// `ui/sessionSummary.ts`. Those modules re-export them, inverting the
// dependency — the same pattern `core/taskPort.ts` / `core/observePort.ts` use.
// Pure leaves: only primitives, nested records, and other open-core types
// (`ContentBlock` / `SystemSegment` from `./types.js`) — no proprietary `src/`
// dependencies.

import type { ContentBlock, SystemSegment } from './types.js';

/** Required fields for creating a persisted session row. Relocated from
 *  `agent/sessionDb.ts` (Phase 2 / Task 2.1) so the open `SessionStore` port
 *  can reference it; `agent/sessionDb.ts` re-exports it (single source of
 *  truth). */
export type CreateSessionInput = {
  model: string;
  provider: string;
  /** Default 'cli'. Phase 16 adds 'telegram' / 'slack' / etc. */
  platform?: string;
  parentSessionId?: string;
  title?: string;
  systemPrompt?: SystemSegment[];
  metadata?: Record<string, unknown>;
  /** Phase 18 T8 — optional pre-supplied session id. When omitted, a UUID is
   *  generated. When supplied (e.g. via X-Session-Id on the OpenAI-compatible
   *  surface), it becomes the row's primary key. Callers must use
   *  `upsertSession` to idempotently land a row when reuse is expected. */
  sessionId?: string;
  /** Phase E — owning principal id for the multi-user gateway. When omitted the
   *  row is unowned (owner_id null) — the single-user CLI / cron back-compat
   *  path. */
  owner?: string;
};

/** Message payload persisted into the session transcript. Relocated from
 *  `agent/sessionDb.ts` (Task 2.1); re-exported there. */
export type SaveMessageInput = {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  toolCallId?: string;
  toolCalls?: unknown;
  tokenCount?: number;
};

/** A persisted message row decoded into runtime content blocks. Relocated from
 *  `agent/sessionDb.ts` (Task 2.1); re-exported there. */
export type StoredMessage = {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  toolCallId: string | null;
  toolCalls: unknown;
  tokenCount: number;
  createdAt: number;
};

/** A persisted session row, including usage and compaction counters. Relocated
 *  from `agent/sessionDb.ts` (Task 2.1); re-exported there. */
export type Session = {
  sessionId: string;
  parentSessionId: string | null;
  model: string;
  provider: string;
  platform: string;
  createdAt: number;
  lastUpdated: number;
  title: string | null;
  systemPrompt: SystemSegment[] | null;
  schemaVersion: number;
  metadata: Record<string, unknown>;
  /** Phase E — owning principal id, or null for unowned rows. */
  ownerId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostUsd: number;
  compactionInputTokens: number;
  compactionOutputTokens: number;
  estimatedCompactionCostUsd: number;
};

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
