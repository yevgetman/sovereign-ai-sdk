// Phase B T3 — Last-Event-ID reconnect + ?follow persistent stream +
// per-session bus lifecycle.
//
// T1 gave ServerEventBus its multi-subscriber fan-out, bounded replay ring,
// and markTurnStart() (unit-proven in eventBus.multiClient.test.ts). T3
// wires the route + runtime to USE them end-to-end:
//
//   1. reconnect replay — a GET /sessions/:id/events stream that disconnects
//      mid-turn can reconnect with `Last-Event-ID: <seq>` (or the
//      `?lastEventId=<n>` query equivalent) and receives ONLY events with
//      seq > that value, with no duplicates, reaching turn_complete.
//   2. ?follow persistence — `GET /sessions/:id/events?follow=true` does NOT
//      close on turn_complete; a SECOND turn's events arrive on the SAME
//      stream. Without ?follow the stream still closes on turn_complete
//      (the default per-turn contract, unchanged).
//   3. lifecycle — after a NON-follow stream closes (turn_complete) the bus
//      is STILL present/replayable (the route no longer disposes it). After
//      runtime.disposeSession(sessionId) the bus IS gone.
//
// These run at the route/integration level against the real
// buildAppWithRuntime + MockProvider stack. The default MockProvider emits
// "Hello world." in two text deltas then stops with end_turn, so each turn
// produces text_delta events + a turn_complete with no tool/permission
// round-trip — exactly the simple per-turn shape these lifecycle assertions
// need.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_busCount, __test_resetAllBuses } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { type ServerEvent, parseServerEvent } from '../../src/server/schema.js';

type SseEvent = {
  event: string;
  id: string | null;
  data: ServerEvent | null;
};

/** Parse one `event:`/`id:`/`data:` SSE block into its parts. The `id` line
 *  carries the per-bus seq the route stamps — that's what a reconnecting
 *  client echoes via Last-Event-ID. */
function parseSseBlock(block: string): SseEvent | null {
  let eventName: string | null = null;
  let idLine: string | null = null;
  let dataLine: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) {
      eventName = line.slice('event: '.length);
    } else if (line.startsWith('id: ')) {
      idLine = line.slice('id: '.length);
    } else if (line.startsWith('data: ')) {
      dataLine = line.slice('data: '.length);
    }
  }
  if (eventName === null) return null;
  const parsed = dataLine !== null ? parseServerEvent(dataLine) : null;
  return { event: eventName, id: idLine, data: parsed };
}

type SseHandle = {
  events: SseEvent[];
  done: Promise<void>;
  onEvent: (cb: (ev: SseEvent) => void) => void;
};

/** Open one SSE subscription, draining in a background loop so the test can
 *  POST turns / disconnect concurrently. Resolves `done` when `stopWhen`
 *  matches OR the stream ends on its own. When `stopWhen` matches, the reader
 *  is cancelled — this simulates a client disconnect (the server sees the
 *  request signal abort). Mirrors the helper in gatewayEndToEnd.test.ts. */
function openSse(
  app: ReturnType<typeof buildAppWithRuntime>,
  path: string,
  stopWhen: (ev: SseEvent) => boolean,
  headers: Record<string, string> = {},
): SseHandle {
  const events: SseEvent[] = [];
  const listeners: Array<(ev: SseEvent) => void> = [];
  const done = (async (): Promise<void> => {
    const res = await app.request(path, { headers });
    if (res.status !== 200) {
      throw new Error(`SSE GET failed: ${res.status} for ${path}`);
    }
    if (res.body === null) {
      throw new Error('SSE response has no body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopHit = false;
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let blockEnd = buffer.indexOf('\n\n');
        while (blockEnd !== -1) {
          const block = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          const parsed = parseSseBlock(block);
          if (parsed !== null) {
            events.push(parsed);
            for (const fn of listeners) fn(parsed);
            if (stopWhen(parsed)) {
              stopHit = true;
              break;
            }
          }
          blockEnd = buffer.indexOf('\n\n');
        }
        if (stopHit) break;
      }
    } finally {
      // cancel() (not just releaseLock) so the underlying request signal
      // aborts — the server's abortHandler then runs unsubscribe() in the
      // route finally, modeling a real client disconnect.
      try {
        await reader.cancel();
      } catch {
        // ignore: cancel can throw if the reader is already closed
      }
    }
  })();
  return {
    events,
    done,
    onEvent: (cb): void => {
      listeners.push(cb);
    },
  };
}

const isTurnEnd = (ev: SseEvent): boolean =>
  ev.event === 'turn_complete' || ev.event === 'turn_error';

describe('events route — Last-Event-ID reconnect (T3)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-reconnect-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-reconnect-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    __test_resetAllBuses();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('reconnect with Last-Event-ID replays only seq > N (no duplicates) and reaches turn_complete', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };

      // Submit a turn. The first SSE subscription drains the FULL turn so we
      // have the complete seq sequence to pick a midpoint from. (Reading the
      // whole turn first, then doing a reconnect replay against the retained
      // ring, is the deterministic way to assert "seq > N only" without
      // racing the in-flight turn.)
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      const first = openSse(app, `/sessions/${sessionId}/events`, isTurnEnd);
      await first.done;

      const allSeqs = first.events
        .map((e) => (e.id !== null ? Number.parseInt(e.id, 10) : Number.NaN))
        .filter((n) => Number.isInteger(n));
      expect(allSeqs.length).toBeGreaterThanOrEqual(3);
      expect(first.events.some((e) => e.event === 'turn_complete')).toBe(true);

      // Pick a midpoint seq to reconnect from.
      const midpoint = allSeqs[Math.floor(allSeqs.length / 2)] as number;

      // Reconnect with Last-Event-ID = midpoint. The non-follow stream replays
      // the retained ring slice (seq > midpoint) and then ends — the
      // turn_complete is still in the ring, so the route delivers it and closes.
      const reconnect = openSse(app, `/sessions/${sessionId}/events`, isTurnEnd, {
        'Last-Event-ID': String(midpoint),
      });
      await reconnect.done;

      const replaySeqs = reconnect.events
        .map((e) => (e.id !== null ? Number.parseInt(e.id, 10) : Number.NaN))
        .filter((n) => Number.isInteger(n));

      // ONLY events with seq > midpoint — no duplicates of what the client
      // already saw.
      expect(replaySeqs.length).toBeGreaterThan(0);
      for (const s of replaySeqs) {
        expect(s).toBeGreaterThan(midpoint);
      }
      // And it reached turn_complete.
      expect(reconnect.events.some((e) => e.event === 'turn_complete')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);

  test('reconnect accepts ?lastEventId=<n> query as an equivalent to the header', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });

      const first = openSse(app, `/sessions/${sessionId}/events`, isTurnEnd);
      await first.done;

      const allSeqs = first.events
        .map((e) => (e.id !== null ? Number.parseInt(e.id, 10) : Number.NaN))
        .filter((n) => Number.isInteger(n));
      const midpoint = allSeqs[Math.floor(allSeqs.length / 2)] as number;

      // Same reconnect, but via the query param instead of the header.
      const reconnect = openSse(
        app,
        `/sessions/${sessionId}/events?lastEventId=${midpoint}`,
        isTurnEnd,
      );
      await reconnect.done;

      const replaySeqs = reconnect.events
        .map((e) => (e.id !== null ? Number.parseInt(e.id, 10) : Number.NaN))
        .filter((n) => Number.isInteger(n));
      expect(replaySeqs.length).toBeGreaterThan(0);
      for (const s of replaySeqs) {
        expect(s).toBeGreaterThan(midpoint);
      }
      expect(reconnect.events.some((e) => e.event === 'turn_complete')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);
});

describe('events route — ?follow persistent stream (T3)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-follow-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-follow-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    __test_resetAllBuses();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('?follow=true keeps the stream open across two turns on the SAME subscription', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };

      // A follow stream that only stops once it has seen TWO turn_complete
      // events — proving it did NOT close on the first one. The count is
      // maintained in ONE place (the onEvent listener below) so stopWhen
      // merely reads it; openSse fires listeners BEFORE stopWhen, so
      // incrementing in both would double-count / race the first-complete gate.
      let completeCount = 0;
      let resolveFirstComplete: (() => void) | null = null;
      const firstComplete = new Promise<void>((resolve) => {
        resolveFirstComplete = resolve;
      });
      const follow = openSse(
        app,
        `/sessions/${sessionId}/events?follow=true`,
        () => completeCount >= 2,
      );
      follow.onEvent((ev) => {
        if (ev.event !== 'turn_complete') return;
        completeCount += 1;
        // Gate the second turn on the first turn finishing so the two turns'
        // events don't interleave ambiguously.
        if (completeCount === 1 && resolveFirstComplete !== null) {
          resolveFirstComplete();
        }
      });

      // Turn 1.
      const turn1 = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'first' }),
      });
      expect(turn1.status).toBe(202);
      await firstComplete;

      // Turn 2 on the same session — its events MUST arrive on the same
      // follow stream that already saw turn 1 complete.
      const turn2 = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'second' }),
      });
      expect(turn2.status).toBe(202);

      await follow.done;

      // Exactly two turn_complete events arrived on this ONE subscription.
      const completes = follow.events.filter((e) => e.event === 'turn_complete');
      expect(completes.length).toBe(2);
      // Sanity: text_delta events from BOTH turns landed on the one stream.
      const textDeltas = follow.events.filter((e) => e.event === 'text_delta');
      expect(textDeltas.length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.dispose();
    }
  }, 20_000);

  test('without ?follow the stream still closes on turn_complete (default per-turn contract)', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });

      // No stopWhen short-circuit: rely on the SERVER to end the stream. If the
      // non-follow contract is broken (stream stays open), this read loop would
      // hang and the test would time out — which is the failure we want to
      // catch. stopWhen returns false always; the loop exits only when the
      // server closes the body.
      const stream = openSse(app, `/sessions/${sessionId}/events`, () => false);
      await stream.done;

      // The server closed the stream after turn_complete (last event).
      const last = stream.events[stream.events.length - 1];
      expect(last?.event).toBe('turn_complete');
      // And it did so exactly once — no second turn was submitted.
      expect(stream.events.filter((e) => e.event === 'turn_complete').length).toBe(1);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);
});

describe('events route — per-session bus lifecycle (T3)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-buslife-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-buslife-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    __test_resetAllBuses();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('a non-follow stream closing does NOT dispose the bus — it stays replayable', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });

      // Drain a full non-follow turn; the stream closes on turn_complete.
      const first = openSse(app, `/sessions/${sessionId}/events`, isTurnEnd);
      await first.done;
      expect(first.events.some((e) => e.event === 'turn_complete')).toBe(true);

      // The bus must STILL be present — the route no longer disposes it in its
      // finally. A reconnect with Last-Event-ID: 0 replays the whole retained
      // ring (the just-finished turn), proving the ring survived the close.
      const reconnect = openSse(app, `/sessions/${sessionId}/events`, isTurnEnd, {
        'Last-Event-ID': '0',
      });
      await reconnect.done;
      expect(reconnect.events.some((e) => e.event === 'turn_complete')).toBe(true);
      // The replay delivered the prior turn's events from the retained ring.
      expect(reconnect.events.length).toBeGreaterThanOrEqual(first.events.length);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);

  test('runtime.disposeSession(sessionId) reclaims the bus — a fresh subscribe gets a new bus', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      const first = openSse(app, `/sessions/${sessionId}/events`, isTurnEnd);
      await first.done;

      // After the turn, the bus exists (route no longer disposes it).
      const countBefore = __test_busCount();
      expect(countBefore).toBeGreaterThanOrEqual(1);

      // Per-session teardown must reclaim the bus + its replay ring.
      await runtime.disposeSession(sessionId);
      expect(__test_busCount()).toBe(countBefore - 1);

      // A fresh subscribe gets a brand-new bus: a Last-Event-ID reconnect now
      // finds an empty ring (the prior turn's events are gone). We submit a new
      // turn so the fresh bus has something to stream and the stream terminates.
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'again' }),
      });
      const fresh = openSse(app, `/sessions/${sessionId}/events`, isTurnEnd, {
        'Last-Event-ID': '999',
      });
      await fresh.done;
      // The fresh bus restarts seq from 1, so even a Last-Event-ID of 999
      // (stale, from the disposed bus) replays nothing from before — the new
      // turn's events still flow because they're live deliveries, not replay.
      expect(fresh.events.some((e) => e.event === 'turn_complete')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);
});
