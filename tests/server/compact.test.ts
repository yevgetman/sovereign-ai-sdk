// Phase 16.1 M6 T5 — POST /sessions/:id/compact synchronous route tests.
//
// Contract under test (M6-03):
//   1. Happy path: POST against a valid session id with persisted history
//      runs runtime.compact() inline, returns 200 with { activeSessionId,
//      summary, estimatedBeforeTokens, estimatedAfterTokens, usedAuxiliary,
//      parentSessionId }, and persists a parent->child lineage row in
//      sessionDb (compactSession itself records lineage at compactor.ts:145).
//   2. Unknown session id: POST against a UUID-shaped id that doesn't exist
//      returns 404 with a JSON error body. The 404 happens BEFORE the
//      runtime.compact() call so an unknown id can't trigger summarizer
//      work.
//
// Test mechanics: provider 'mock' boots without credentials; the default
// streamHelloWorld path produces 'Hello world.' for the same-provider
// summarize callback inside buildServerCompactor (which mirrors the
// auxiliary path's assistant_message fallback when no text deltas appear).
// SOV_TEST_MOCK_PROVIDER=1 keeps any auxiliary-client probe inside the
// compactor on the deterministic mock path too.
//
// File-naming note: tests/server/ is flat (no routes/ subdirectory) — the
// route source lives under src/server/routes/ but the existing tests
// (approvals.test.ts, sessions.test.ts, turns.*.test.ts) all sit at the
// tests/server/ root, so this file matches that convention.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('POST /sessions/:id/compact (M6 T5)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-m6-t5-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('compacts a session inline and returns the JSON CompactResult', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed enough prior history so the compactor has something to summarize.
      // The exact size doesn't matter for the explicit-verb path (no threshold
      // probe — the user is asking for it) but a non-empty transcript ensures
      // the summarize callback gets a real prompt and the before/after token
      // counts are positive.
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'first user turn body for compaction input' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: 'first assistant reply containing facts' }],
      });

      const compactRes = await app.request(`/sessions/${sessionId}/compact`, {
        method: 'POST',
      });
      expect(compactRes.status).toBe(200);

      const body = (await compactRes.json()) as {
        activeSessionId: string;
        parentSessionId: string;
        summary: string;
        estimatedBeforeTokens: number;
        estimatedAfterTokens: number;
        usedAuxiliary: boolean;
      };

      // activeSessionId must be a fresh child id, distinct from the input.
      expect(typeof body.activeSessionId).toBe('string');
      expect(body.activeSessionId.length).toBeGreaterThan(0);
      expect(body.activeSessionId).not.toBe(sessionId);

      // parentSessionId echoes the input so the TUI can pivot without
      // remembering the URL it called.
      expect(body.parentSessionId).toBe(sessionId);

      // Summary must be non-empty (compactSession's own contract — it throws
      // if the summarizer returns ''). The mock's default streamHelloWorld
      // path drives the same-provider summarize callback's
      // assistant_message fallback, producing 'Hello world.'.
      expect(typeof body.summary).toBe('string');
      expect(body.summary.length).toBeGreaterThan(0);

      // Token estimates surface for footer / status rendering.
      expect(typeof body.estimatedBeforeTokens).toBe('number');
      expect(typeof body.estimatedAfterTokens).toBe('number');
      expect(body.estimatedBeforeTokens).toBeGreaterThan(0);

      // Same-provider summarize path (M6-06 inline decision) — NOT auxiliary.
      expect(body.usedAuxiliary).toBe(false);

      // Lineage row exists: parent is the original sessionId, child is the
      // newSessionId minted inside compactSession (compactor.ts:145).
      const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(lineage.length).toBe(1);
      expect(lineage[0]?.childSessionId).toBe(body.activeSessionId);
    } finally {
      await runtime.dispose();
    }
  });

  test('returns 404 with a JSON error body for an unknown session id', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const app = buildAppWithRuntime(runtime);

      // Valid-shaped UUID that was never created. isValidSessionId accepts
      // it (matches SESSION_ID_PATTERN); the route's getSession lookup
      // returns null, and the route 404s before invoking runtime.compact().
      const res = await app.request('/sessions/00000000-0000-0000-0000-000000000000/compact', {
        method: 'POST',
      });
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe('string');
      expect((body.error ?? '').length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });
});
