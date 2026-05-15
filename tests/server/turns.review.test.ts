// Phase 16.1 M7 T6 — review manager wired into SessionContext.
//
// Verifies that the per-session SessionContext constructs a ReviewManager
// (when review isn't disabled in settings), exposes the same trigger surface
// the orchestrator/scheduler already call into (onUserTurn / onToolIteration
// / onChildCompletion), and emits a `session_summary` SSE event on session
// disposal so the TUI can render the goodbye card (M9 polish).
//
// Three contracts:
//   1. Default settings → SessionContext.reviewManager is constructed; the
//      manager surface (onUserTurn, onToolIteration, onChildCompletion) is
//      callable.
//   2. review.disabled === true in user settings → reviewManager left
//      undefined so the orchestrator's ?. optional-chain becomes a no-op.
//   3. `disposeSession(id, { bus })` emits a `session_summary` event onto
//      the supplied bus with the getDispatchSummary payload.
//
// Per src/config/store.ts, HARNESS_CONFIG (not HARNESS_CONFIG_PATH) is the
// env var the loader honors — mirrors the M7 T5 test pattern.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { ServerEvent } from '../../src/server/schema.js';

describe('turns route — review manager (M7 T6)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t6-'));
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_CONFIG;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('SessionContext exposes reviewManager when enabled', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'mock',
        platform: 'test',
      });

      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.reviewManager).toBeDefined();

      // Sanity: trigger methods exist on the manager. The orchestrator
      // (src/core/query.ts:352) and scheduler (src/runtime/scheduler.ts:326)
      // already call these via optional-chain; this asserts the field
      // exposes the same shape.
      expect(typeof ctx.reviewManager?.onUserTurn).toBe('function');
      expect(typeof ctx.reviewManager?.onToolIteration).toBe('function');
      expect(typeof ctx.reviewManager?.onChildCompletion).toBe('function');
    } finally {
      await runtime.dispose();
    }
  });

  test('review.disabled === true — reviewManager left undefined', async () => {
    const configPath = join(tmpHome, 'config.json');
    writeFileSync(configPath, JSON.stringify({ review: { disabled: true } }));
    process.env.HARNESS_CONFIG = configPath;

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'mock',
        platform: 'test',
      });
      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.reviewManager).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  test('disposeSession emits session_summary onto an attached bus', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'mock',
        platform: 'test',
      });

      const bus = new ServerEventBus();
      const captured: ServerEvent[] = [];
      bus.subscribe((evt) => captured.push(evt));

      // Touch the SessionContext so the review manager is constructed before
      // disposal walks the registry.
      runtime.getSessionContext(sessionId);

      // No counters tripped → getDispatchSummary returns {0, {}}. The event
      // still fires so the TUI can render an empty goodbye card.
      await runtime.disposeSession(sessionId, { bus });

      const summary = captured.find((e) => e.type === 'session_summary');
      expect(summary).toBeDefined();
      if (summary && summary.type === 'session_summary') {
        expect(summary.sessionId).toBe(sessionId);
        expect(summary.totalDispatched).toBe(0);
        expect(summary.byAgent).toEqual({});
      }
    } finally {
      await runtime.dispose();
    }
  });

  // M7 T6 follow-up (review I1) — the turns route must invoke
  // reviewManager.onUserTurn(sessionId) on every user prompt. Without this
  // wiring, two user-tunable settings (review.userTurnsForMemoryReview and
  // learning.synthesizerEveryN) are silently inert in server mode because
  // their counters never increment. Mirrors terminalRepl.ts:1283,1290.
  //
  // Spy-based assertion (preferred over a real scheduler-dispatch test): we
  // monkey-patch onUserTurn on the live ReviewManager instance before firing
  // the turn, then assert it was called with the session id. Dispatch
  // internals (and the `review-memory` agent fixture availability) stay out
  // of scope — we only verify the wire is connected.
  test('POST /sessions/:id/turns invokes reviewManager.onUserTurn', async () => {
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });

    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Build the SessionContext up-front so the ReviewManager exists before
      // the spy is installed. runTurnInBackground also calls
      // getSessionContext, but it returns the cached instance (lazy-build).
      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.reviewManager).toBeDefined();

      const calls: string[] = [];
      const original = ctx.reviewManager?.onUserTurn.bind(ctx.reviewManager);
      // biome-ignore lint/style/noNonNullAssertion: guarded by the expect above.
      ctx.reviewManager!.onUserTurn = (callerSessionId: string) => {
        calls.push(callerSessionId);
        original?.(callerSessionId);
      };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the background turn completes deterministically.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      expect(calls).toEqual([sessionId]);
    } finally {
      await runtime.dispose();
    }
  });
});
