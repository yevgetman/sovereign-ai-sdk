// ux-fixes round 4 — POST /sessions/:id/cancel route tests.
//
// Contract under test:
//   1. Happy path: POST against a valid session id with no active turn
//      returns 200 with { cancelled: false } — idempotent no-op.
//   2. Invalid id: POST against a malformed id returns 400 with an error
//      body and never reaches the bus.
//   3. Active-turn cancel: when a turn IS in flight (via setCurrentTurnAbort
//      registered by runTurnInBackground), the route fires the controller
//      and returns { cancelled: true }. End-to-end is exercised through
//      the live turns path but verifying the bus-level behavior here keeps
//      the unit scope tight.
//
// Test mechanics mirror tests/server/compact.test.ts — mock provider,
// per-test temp $HARNESS_HOME, full runtime build.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses, getOrCreateBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('POST /sessions/:id/cancel (ux-fixes round 4)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-cancel-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetAllBuses();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
    __test_resetAllBuses();
  });

  test('returns { cancelled: false } when no turn is active', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const cancelRes = await app.request(`/sessions/${sessionId}/cancel`, {
        method: 'POST',
      });
      expect(cancelRes.status).toBe(200);
      const body = (await cancelRes.json()) as { cancelled: boolean };
      expect(body.cancelled).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('returns 400 on malformed session id', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const app = buildAppWithRuntime(runtime);
      // Special characters that fail SESSION_ID_PATTERN's
      // alphanumeric/dash/underscore character class. Mirrors the
      // canonical 400 pattern in tests/server/compact.test.ts.
      const cancelRes = await app.request('/sessions/bad%20id!/cancel', {
        method: 'POST',
      });
      expect(cancelRes.status).toBe(400);
      const body = (await cancelRes.json()) as { error: string };
      expect(body.error).toContain('invalid session id');
    } finally {
      await runtime.dispose();
    }
  });

  test('aborts the current turn when one is registered', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Simulate runTurnInBackground's pre-query registration: allocate a
      // controller, register on the bus, then have the cancel route fire
      // it. The signal MUST end up aborted after the POST returns.
      const bus = getOrCreateBus(sessionId);
      const controller = new AbortController();
      bus.setCurrentTurnAbort(controller);

      const cancelRes = await app.request(`/sessions/${sessionId}/cancel`, {
        method: 'POST',
      });
      expect(cancelRes.status).toBe(200);
      const body = (await cancelRes.json()) as { cancelled: boolean };
      expect(body.cancelled).toBe(true);
      expect(controller.signal.aborted).toBe(true);

      // A subsequent cancel returns false because the bus cleared its
      // turn-abort pointer after firing (cancelCurrentTurn doesn't clear,
      // but the same controller is already aborted and would no-op; the
      // bus's pointer still references it). Verify the contract: a real
      // post-finally clearCurrentTurnAbort() returns the bus to the
      // no-turn-active state.
      bus.clearCurrentTurnAbort();
      const cancelRes2 = await app.request(`/sessions/${sessionId}/cancel`, {
        method: 'POST',
      });
      const body2 = (await cancelRes2.json()) as { cancelled: boolean };
      expect(body2.cancelled).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
