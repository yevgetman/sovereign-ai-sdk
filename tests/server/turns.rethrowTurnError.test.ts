// Task 7.2 — the gateway error-path regression fix (createAgent `rethrow`).
//
// The Task 7.1 re-seat drove each turn through `createAgent().run()`, whose
// default `run()` wraps the query() drive in a try/catch that CONVERTS a thrown
// error into `terminal{reason:'error'}` and returns normally. But query() runs
// three async ops OUTSIDE its per-turn try/catch that can THROW out of the
// generator: memory injection (`prefetchSnapshot`), the recall thunk, and the
// UserPromptSubmit hook. Pre-7.1 (direct query() drive) such a throw propagated
// out of runOnce → the route's outer catch → `turn_error{recoverable:false}`.
// Post-7.1 it was swallowed → `turn_complete{finishReason:'error'}` — a wire
// regression.
//
// The fix: the gateway passes `rethrow: true` in its per-hop bag, so the throw
// PROPAGATES out of `run()` again → the outer catch → `turn_error`. This test
// drives the closest reachable pre-loop throw — the session's
// `memoryManager.prefetchSnapshot` (always present on the gateway, built in
// buildSessionContext) — and pins the OLD wire surface back in place.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('turns route — pre-loop throw surfaces as turn_error (Task 7.2)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-task-7-2-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('a turn whose memory injection throws emits turn_error{recoverable:false} (NOT turn_complete) + status_update streaming:false + failed-trajectory bucketing', async () => {
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

      // Force a PRE-LOOP throw: the cached SessionContext's memoryManager is
      // what the turn threads into query() (turns.ts) — overriding its
      // prefetchSnapshot to throw makes query()'s pre-loop injection escape the
      // generator, exactly like the recall thunk or UserPromptSubmit hook would.
      const ctx = runtime.getSessionContext(sessionId);
      ctx.memoryManager.prefetchSnapshot = async (): Promise<string> => {
        throw new Error('memory injection boom (task 7.2 pre-loop throw)');
      };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turnRes.status).toBe(202);

      // The default (non-follow) events stream closes on turn_complete OR
      // turn_error, so the body carries the full terminal sequence.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // The restored wire surface: turn_error, NOT turn_complete.
      expect(body).toContain('event: turn_error');
      expect(body).not.toContain('event: turn_complete');
      // recoverable:false — the outer catch's non-recoverable error surface.
      expect(body).toContain('"recoverable":false');
      // M9 T10 — the spinner is flushed off on error too.
      expect(body).toContain('"streaming":false');

      // Failed-trajectory bucketing: the outer catch records terminalReason
      // 'error' on the session's context so disposal routes it into failed.jsonl
      // (the trajectory writer's COMPLETED_REASONS excludes 'error').
      expect(runtime.getSessionContext(sessionId).trajectoryMetadata.terminalReason).toBe('error');
    } finally {
      await runtime.dispose();
    }
  });
});
