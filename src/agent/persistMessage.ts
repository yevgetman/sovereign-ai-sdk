// persistMessage (2026-06-15) — the single app-layer wrapper for persisting a
// conversation message. It writes the authoritative `messages` row AND appends
// the always-on per-session transcript line, so the JSONL transcript can never
// drift from the DB. Every former `SessionDb.saveMessage` call site (turns
// route, channels, OpenAI API server, compaction) calls this instead.
//
// Returns the saveMessage row id verbatim (drop-in for the old call), so the
// transcript append is a pure side effect. Structurally typed on the host so
// this module never imports the heavy Runtime type (avoids a cycle); the live
// Runtime matches it.

import type { FileTranscriptStore } from '@yevgetman/sov-sdk/transcript/store';
import type { SaveMessageInput, SessionDb } from './sessionDb.js';

export type PersistMessageHost = {
  sessionDb: SessionDb;
  /** Optional — surfaces without a runtime store (e.g. `sov config` standalone)
   *  simply persist to the DB. */
  transcripts?: FileTranscriptStore;
};

/** Persist a message to the DB and append it to the session transcript.
 *  Returns the new message row id (identical to `sessionDb.saveMessage`). */
export function persistMessage(
  host: PersistMessageHost,
  sessionId: string,
  msg: SaveMessageInput,
): number {
  const id = host.sessionDb.saveMessage(sessionId, msg);
  host.transcripts?.recordMessage(sessionId, msg.role, msg.content, id);
  return id;
}
