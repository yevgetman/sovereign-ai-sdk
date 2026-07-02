// src/persistence/transcriptStore.ts — the open `TranscriptStore` port (Phase 2
// / Task 2.2).
//
// The injectable transcript boundary for the open SDK. `createAgent` (Phase 3)
// records each persisted message THROUGH this port, so an embedded agent can run
// with NO disk: omit the port → no transcript writes, or pass the no-op default
// (`noopTranscriptStore.ts`) to explicitly discard. The (B) in-process surfaces
// (cron / channels / mission, Phase 4) inject a real store to close the parity
// gap. The file-based `FileTranscriptStore` (`src/transcript/store.ts`) is the
// production JSONL implementation; it `implements TranscriptStore` unchanged.
//
// SCOPE — exactly the three caller-facing methods every message-persistence call
// site reaches through `persistMessage`:
//   • recordMessage — append a persisted message to its session's transcript.
//   • closeSession  — drain + drop one session's writer.
//   • closeAll      — drain + drop every writer.
// The `projectsDir` getter and the per-session writer cache stay on the concrete
// class, off the port (a presentation/implementation concern).
//
// Method names + signatures MIRROR FileTranscriptStore exactly so the concrete
// class satisfies this interface structurally (`implements TranscriptStore`) with
// no body changes. References only OPEN types (`Role`, `ContentBlock` from
// `core/types`).

import type { ContentBlock, Role } from '../core/types.js';

export interface TranscriptStore {
  /** Append a persisted message to its session's transcript. Lazily creates the
   *  per-session writer on first use. Must never throw — transcript failures
   *  must not break a turn. */
  recordMessage(sessionId: string, role: Role, content: ContentBlock[], seq: number): void;

  /** Drain + drop the writer for one session (called on disposeSession). */
  closeSession(sessionId: string): Promise<void>;

  /** Drain + drop every writer (called on runtime dispose). */
  closeAll(): Promise<void>;
}
