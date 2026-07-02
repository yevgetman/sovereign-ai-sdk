// transcriptStorePort — the open `TranscriptStore` port + its no-op default
// (Phase 2 / Task 2.2). Proves the concrete file-based store satisfies the port
// structurally and that the no-op default discards every call safely.

import { describe, expect, test } from 'bun:test';
import { createNoopTranscriptStore } from '@yevgetman/sov-sdk/persistence/noopTranscriptStore';
import type { TranscriptStore } from '@yevgetman/sov-sdk/persistence/transcriptStore';
import { FileTranscriptStore } from '@yevgetman/sov-sdk/transcript/store';

describe('TranscriptStore port', () => {
  test('FileTranscriptStore structurally satisfies the TranscriptStore port', () => {
    // `enabled: false` keeps the concrete store a complete no-op (no fs touch) —
    // we only need a constructed instance to exercise the compile-time
    // assignability check below.
    const concrete: FileTranscriptStore = new FileTranscriptStore({
      enabled: false,
      base: '/x',
      redactSecrets: true,
      cwd: '/p',
      getSession: () => null,
    });
    // The `: TranscriptStore` annotation forces structural conformance at
    // typecheck; `tsc --noEmit` is the real assertion. The runtime checks below
    // just confirm the three caller-facing methods exist.
    const port: TranscriptStore = concrete;
    expect(typeof port.recordMessage).toBe('function');
    expect(typeof port.closeSession).toBe('function');
    expect(typeof port.closeAll).toBe('function');
  });

  test('createNoopTranscriptStore() accepts every call, throws nothing, writes nothing', async () => {
    const sink = createNoopTranscriptStore();
    expect(() => sink.recordMessage('s1', 'user', [{ type: 'text', text: 'hi' }], 1)).not.toThrow();
    // No base dir, no writer, no fs access — nothing to flush; both resolve.
    await expect(sink.closeSession('s1')).resolves.toBeUndefined();
    await expect(sink.closeAll()).resolves.toBeUndefined();
  });
});
