// src/persistence/noopTranscriptStore.ts — the no-op `TranscriptStore` default
// (Phase 2 / Task 2.2).
//
// A complete no-op implementation of the open `TranscriptStore` port: every call
// is discarded, nothing touches the filesystem. This is the explicit "discard
// transcripts" option for SDK consumers that want a non-undefined sink (a
// concrete value to inject and call unconditionally). `createAgent` (Phase 3)
// also accepts `undefined` to mean "no transcripts" — the no-op is the same
// observable behavior with a real object, so call sites need no null-guards.

import type { TranscriptStore } from './transcriptStore.js';

/** A `TranscriptStore` that discards every call (no disk, no side effects). */
export function createNoopTranscriptStore(): TranscriptStore {
  return {
    recordMessage() {},
    async closeSession() {},
    async closeAll() {},
  };
}
