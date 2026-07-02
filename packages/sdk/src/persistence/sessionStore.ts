// src/persistence/sessionStore.ts — the open `SessionStore` port (Phase 2 /
// Task 2.1).
//
// The injectable persistence boundary for the open SDK. `createAgent` (Phase 3)
// persists a session's turn/history state THROUGH this port, so an embedded
// agent can run with the in-memory default (`inMemoryStore.ts`) — no disk, no
// SQLite. The proprietary `agent/sessionDb.ts` (`SessionDb`) is the production
// WAL-backed SQLite implementation; it `implements SessionStore` unchanged.
//
// SCOPE — deliberately NARROW. This is exactly the turn-driving +
// history-hydration subset the agent-turn path needs:
//   • lifecycle: createSession / getSession / upsertSession / updateSessionModel
//   • messages:  saveMessage / loadMessages
//   • usage:     recordTokenUsage
// The full SessionDb admin/search/routing-atom/cleanup/metrics surface and the
// raw `handle` getter are intentionally OFF the port — they're concrete-store
// concerns, not part of what an embedded agent persists through.
//
// Method names + signatures MIRROR SessionDb exactly so the concrete class
// satisfies this interface structurally (`implements SessionStore`) with no body
// changes. References only OPEN types: the session DTOs from `core/sessionPort`
// (relocated there for the same reason) and `TokenUsage` from `core/types`.

import type {
  CreateSessionInput,
  SaveMessageInput,
  Session,
  StoredMessage,
} from '../core/sessionPort.js';
import type { TokenUsage } from '../core/types.js';

export interface SessionStore {
  /** Create a persisted session row. Returns the session id (a fresh UUID when
   *  `input.sessionId` is omitted, otherwise the supplied id). */
  createSession(input: CreateSessionInput): string;

  /** Idempotent session creation. When `input.sessionId` is supplied and the row
   *  already exists, this is a no-op and the existing id is returned (the row's
   *  original configuration is preserved). Otherwise a row is created. */
  upsertSession(input: CreateSessionInput): string;

  /** Load a single session by id. When `owner` is supplied the row is only
   *  returned if its `ownerId` matches (per-principal scoping); an unowned row
   *  never matches a real principal. Omitting `owner` returns the row regardless
   *  of ownership (the single-user / internal back-compat path). */
  getSession(sessionId: string, owner?: string): Session | null;

  /** Persist a model change so the chosen model survives resume. Only the
   *  `model` field (and the last-updated timestamp) changes. */
  updateSessionModel(sessionId: string, model: string): void;

  /** Append a message to the session transcript. Returns the new row's id. */
  saveMessage(sessionId: string, msg: SaveMessageInput): number;

  /** Load a session's persisted messages in insertion (id-ascending) order. */
  loadMessages(sessionId: string): StoredMessage[];

  /** Accumulate token usage + estimated cost onto the session's running totals
   *  (additive — each call adds to the existing counters). */
  recordTokenUsage(sessionId: string, usage: TokenUsage, estimatedCostUsd: number): void;
}
