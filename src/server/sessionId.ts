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
// projects them into the `Message` shape the model, compactor, and `/export`
// consume. A runtime continuation row keeps its origin and stable id.

import type { Message } from '@yevgetman/sov-sdk/core/types';
import type { SessionDb } from '../agent/sessionDb.js';
import { storedRowToMessage } from './turnComposition.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && SESSION_ID_PATTERN.test(id);
}

/** Load a session's persisted history and project each row to a `Message`.
 *  A runtime continuation row keeps its origin and stable id. Compact,
 *  channel seed, and `/export` share this projection. */
export function loadHistoryAsMessages(sessionDb: SessionDb, sessionId: string): Message[] {
  return sessionDb.loadMessages(sessionId).map(storedRowToMessage);
}
