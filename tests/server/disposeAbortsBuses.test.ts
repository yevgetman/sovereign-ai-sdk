// Phase A gateway hardening (Fix 3) — abort in-flight session buses
// before closing the DB on dispose().
//
// On SIGINT during an active turn, runtime.dispose() closed sessionDb but
// never aborted in-flight background turns / their SSE buses. A running
// query() would keep writing to a closed DB handle until process.exit.
// dispose() must abort every live session bus BEFORE sessionDb.close(),
// so each in-flight turn's query() (which rides the bus abortSignal)
// cooperatively cancels before the DB handle goes away.
//
// Two checks:
//   1. Ordering: a live bus is aborted before sessionDb.close() runs.
//   2. Behavioral: a slow turn disposed mid-flight unwinds without an
//      unhandled rejection or a write-to-closed-DB throw.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses, getOrCreateBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('dispose() aborts in-flight buses before closing the DB (Fix 3)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-dispose-abort-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetAllBuses();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    rmSync(home, { recursive: true, force: true });
    __test_resetAllBuses();
  });

  test('a live bus is aborted before sessionDb.close() runs', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // Allocate a live bus for this session (as a running turn would).
    const bus = getOrCreateBus(sessionId);
    expect(bus.isClosed()).toBe(false);

    // Record the order of two events: the bus abort firing, and
    // sessionDb.close() being invoked. The fix requires the abort to land
    // first so an in-flight query() (riding bus.abortSignal) cancels before
    // the DB handle goes away.
    const order: string[] = [];
    bus.abortSignal.addEventListener('abort', () => order.push('bus-abort'), { once: true });
    const realClose = runtime.sessionDb.close.bind(runtime.sessionDb);
    runtime.sessionDb.close = () => {
      order.push('db-close');
      realClose();
    };

    await runtime.dispose();

    expect(bus.isClosed()).toBe(true);
    expect(order).toContain('bus-abort');
    expect(order).toContain('db-close');
    expect(order.indexOf('bus-abort')).toBeLessThan(order.indexOf('db-close'));
  });

  test('disposing mid-turn unwinds without an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onRejection);

    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      // Skip the boot preflight smoke-call: with slowMode on it would park
      // for slowModeDelayMs inside buildRuntime. We want only the turn to
      // park, not the boot.
      preflight: false,
    });
    // Park the mock stream between yields so the turn is genuinely
    // in-flight when dispose() fires. maybeDelay() observes the abort
    // signal, so the bus abort interrupts the wait and the generator
    // unwinds cooperatively (instead of writing to a closed DB). Set AFTER
    // buildRuntime so the boot path runs at normal speed.
    MockProvider.slowMode = true;
    MockProvider.slowModeDelayMs = 10_000;
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Kick off the turn (fire-and-forget on the server side). It parks in
      // maybeDelay() almost immediately.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      // Let the background turn reach its parked delay before we dispose.
      // By now runTurnInBackground has registered its per-turn
      // AbortController on the bus (setCurrentTurnAbort) and query() is
      // parked in the provider stream.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const bus = getOrCreateBus(sessionId);
      expect(bus.isClosed()).toBe(false);

      // dispose() must abort the live bus (cancelling the parked query())
      // before sessionDb.close(). Without the fix, the still-running turn
      // would write to the closed DB handle.
      await runtime.dispose();

      // Give any aborted-turn microtasks a chance to surface a rejection.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // The fix's observable effect: the live bus is closed (its abort
      // signal fired, which is the signal the parked query() rides). This
      // assertion fails without abortAllBuses() in dispose().
      expect(bus.isClosed()).toBe(true);
      expect(bus.abortSignal.aborted).toBe(true);
      // The cooperative cancel must not surface as an unhandled rejection.
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
