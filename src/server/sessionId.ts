// Server-side session-id helpers shared across routes.
//
// `isValidSessionId` validates the `:id` path parameter on /sessions/:id and
// /sessions/:id/* routes. Session ids are UUIDs in production but the
// validator only enforces the character class — the lookup will 404 if the
// id is shaped right but doesn't exist. Rejecting empty/malformed ids here
// prevents the id from being echoed unsanitized into SSE event payloads or
// session DB queries.
//
// `loadHistoryAsMessages` reads the persisted message rows for a session and
// projects them into the `Message` shape the model + compactor consume. The
// cast narrows the storage role string to the `Message['role']` union without
// changing the underlying value. Drift between callers (turns route + compact
// route) would diverge the model's pre-compaction view from the turn-time
// view — keeping a single helper guarantees the projection stays aligned.

import type { Message } from '@yevgetman/sov-sdk/core/types';
import type { SessionDb } from '../agent/sessionDb.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && SESSION_ID_PATTERN.test(id);
}

/** Load a session's persisted history and project each row to a `Message`.
 *  The cast narrows the storage `role` string to the `Message['role']` union
 *  without changing the underlying value. Both the turns route (proactive +
 *  recovery hydration) and the compact route (pre-compaction history view)
 *  use this; keeping a single helper ensures any future signature change
 *  (e.g. column additions, content-shape migrations) updates both paths
 *  together. */
export function loadHistoryAsMessages(sessionDb: SessionDb, sessionId: string): Message[] {
  return sessionDb.loadMessages(sessionId).map(
    (m): Message => ({
      role: m.role as Message['role'],
      content: m.content,
    }),
  );
}
