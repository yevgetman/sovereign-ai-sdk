// Contract #2 — the 6-endpoint request/response wire shapes, as PURE types.
//
// OPEN + import-free (no zod, no runtime deps, no proprietary code). Authored
// from the gateway handlers' current inline casts / literal returns:
//   - POST   /sessions                              src/server/routes/sessions.ts:86
//   - POST   /sessions/:id/turns                    src/server/routes/turns.ts:177,291
//   - POST   /sessions/:id/approvals/:requestId     src/server/routes/approvals.ts:55,85
//   - POST   /sessions/:id/cancel                   src/server/routes/cancel.ts:51
//   - GET    /sessions/:id/events                   src/server/routes/events.ts (SSE; payload = ServerEvent)
//   - GET    /health                                src/server/routes/health.ts:11
//
// The handlers are NOT yet wired to these types (that is task 6.2); the
// conformance guard (tests/protocol/conformance.test.ts) pins each type against
// the handler's recorded shape so they cannot silently drift.

import type { ServerEvent } from './events.js';

/** The error envelope every JSON route returns on a 4xx/5xx
 *  (`c.json({ error }, status)`). */
export interface ErrorResponse {
  error: string;
}

/** A request that carries no body (the handler never parses one). */
export type EmptyRequest = Record<string, never>;

// --- POST /sessions ---------------------------------------------------------
// No request body. 201 → { sessionId, createdAt }. `createdAt` is an ISO-8601
// string (`new Date().toISOString()`), NOT an epoch number.

export type CreateSessionRequest = EmptyRequest;

export interface CreateSessionResponse {
  sessionId: string;
  createdAt: string;
}

// --- POST /sessions/:id/turns -----------------------------------------------
// Body { text, kind }. 202 → { accepted: true }. `kind: 'skill'` opts into
// server-side skill expansion (text must start with `/`).

export interface PostTurnRequest {
  text?: string;
  kind?: string;
}

export interface PostTurnResponse {
  accepted: boolean;
}

// --- POST /sessions/:id/approvals/:requestId --------------------------------
// Body { approved, always?, updatedInput? }. `approved` is required (validated
// as a strict boolean); `always` is an optional boolean; `updatedInput` is an
// optional opaque tool-input override. 200 → { ok: true }.

export interface PostApprovalRequest {
  approved: boolean;
  always?: boolean;
  updatedInput?: unknown;
}

export interface PostApprovalResponse {
  ok: boolean;
}

// --- POST /sessions/:id/cancel ----------------------------------------------
// No request body. 200 → { cancelled } — true when a turn was active and its
// controller fired, false on the idempotent no-op.

export type CancelTurnRequest = EmptyRequest;

export interface CancelTurnResponse {
  cancelled: boolean;
}

// --- GET /sessions/:id/events -----------------------------------------------
// Server-Sent Events stream. Each `data:` frame is one JSON-serialized
// `ServerEvent`; the SSE `event:` field is the event's `type` and `id:` is its
// `seq`. Re-exported for the client (task 6.2) so the stream payload type has a
// single import site.

export type { ServerEvent };

// --- GET /health ------------------------------------------------------------
// No request body. 200 → { ok, version }.

export interface HealthResponse {
  ok: boolean;
  version: string;
}

// --- Endpoint path templates ------------------------------------------------
// The ONLY runtime values in the protocol module (path-string constants are
// explicitly sanctioned). Hono-style `:param` placeholders, so the client can
// derive concrete URLs without re-copying the route strings.

export const PROTOCOL_PATHS = {
  health: '/health',
  sessions: '/sessions',
  session: '/sessions/:id',
  messages: '/sessions/:id/messages',
  turns: '/sessions/:id/turns',
  approval: '/sessions/:id/approvals/:requestId',
  cancel: '/sessions/:id/cancel',
  events: '/sessions/:id/events',
} as const;

export type ProtocolPathName = keyof typeof PROTOCOL_PATHS;
