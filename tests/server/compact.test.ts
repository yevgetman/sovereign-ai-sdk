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
import { wrapTransportWithFailingSummarize } from '../helpers/transportWrappers.js';

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

      // Seed enough prior history that the compactor has something to
      // summarize AND clears the DEFAULT_MIN_TAIL_MESSAGES=4 floor so
      // `head` is non-empty. Backlog #36: a history that fits within the
      // tail budget OR doesn't reach the min-tail floor short-circuits to
      // a no-op (parentSessionId === newSessionId, noOp: true) — the
      // original 2-message arrangement now hits that path, which would
      // make activeSessionId === sessionId and break the happy-path
      // assertion. 6 filler messages clear both thresholds.
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      for (let i = 0; i < 3; i += 1) {
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'user',
          content: [{ type: 'text', text: `user turn ${i}: ${filler}` }],
        });
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'assistant',
          content: [{ type: 'text', text: `assistant reply ${i}: ${filler}` }],
        });
      }

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

      // Body shape MUST match sessions.ts (:41, :54) — `{ error: 'not found' }`
      // with no echoed sessionId. Pinning the exact string keeps the wire
      // contract aligned across sibling 404s; a future drift to a different
      // message would land here as a regression.
      const body = (await res.json()) as { error?: string; sessionId?: string };
      expect(body.error).toBe('not found');
      expect(body.sessionId).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  test('returns 400 for an invalid session id', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const app = buildAppWithRuntime(runtime);

      // 'bad id!' contains characters outside [A-Za-z0-9_-] so
      // isValidSessionId rejects it before any sessionDb lookup. Mirrors
      // the canonical 400 pattern from sessions.test.ts:80-97 — same
      // sibling-route validator, same rejected-character rationale.
      const res = await app.request('/sessions/bad%20id!/compact', {
        method: 'POST',
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid session id');
    } finally {
      await runtime.dispose();
    }
  });

  test('returns 500 with a JSON error body when runtime.compact() throws', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      // Wrap the resolved transport so the summarize-shaped call (detected
      // by the exact `compressionSystemPrompt()` text in `req.system`)
      // throws. compactSession then rejects, runtime.compact propagates the
      // error, and the route's catch lands a 500 — exactly the hazard
      // surface this test is here to pin. Pass-through on every other call
      // keeps the wrapper drop-in compatible with any other in-runtime
      // provider invocation.
      runtime.resolvedProvider.transport = wrapTransportWithFailingSummarize(
        runtime.resolvedProvider.transport,
      );

      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed a non-empty history so the route hydrates and reaches the
      // runtime.compact() call (the summarize path inside compactSession is
      // what throws). Backlog #36: a tiny history that fits within the
      // tail budget short-circuits to a no-op (noOp: true) and the
      // failing summarize callback never runs — losing this test's target.
      // 6 filler messages clear both DEFAULT_TAIL_TOKEN_BUDGET=4_000 and
      // DEFAULT_MIN_TAIL_MESSAGES=4 so `head` is non-empty.
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      for (let i = 0; i < 3; i += 1) {
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'user',
          content: [{ type: 'text', text: `user turn ${i}: ${filler}` }],
        });
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'assistant',
          content: [{ type: 'text', text: `assistant reply ${i}: ${filler}` }],
        });
      }

      const compactRes = await app.request(`/sessions/${sessionId}/compact`, {
        method: 'POST',
      });
      expect(compactRes.status).toBe(500);

      const body = (await compactRes.json()) as { error?: string };
      // The route surfaces the thrown Error's message verbatim. Pinning
      // the exact string ensures the catch isn't accidentally swallowing
      // the failure detail (e.g. via a generic 'compaction failed' label).
      expect(body.error).toBe('mock summarizer failure');

      // No lineage row — compactSession threw before recordCompactionLineage,
      // so the parent must show zero compactions even though the route was
      // invoked. Confirms the 500 path didn't accidentally persist partial
      // state.
      const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(lineage.length).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });
});
