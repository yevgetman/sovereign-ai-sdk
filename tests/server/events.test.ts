// Phase 16.1 M3 — events route consumes the per-session event bus.
// Test seeds the bus with synthetic events, GETs the SSE endpoint, and
// asserts the on-wire payload contains them plus a terminal turn_complete.
//
// Phase E T4 — the events route now resolves the session through the ownership
// chokepoint before minting a bus, so the seeded bus must correspond to a real
// session row. We mint one via a real runtime (open mode → owner null → no
// per-principal enforcement) and seed THAT session's bus.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses, getOrCreateBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { parseServerEvent } from '../../src/server/schema.js';

describe('eventsRoute (M3 bus-driven)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'events-route-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'events-route-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetAllBuses();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    __test_resetAllBuses();
    MockProvider.lastMessages = undefined;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('GET /sessions/:id/events streams buffered bus events + terminal turn_complete', async () => {
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
      // Mint a real session so the ownership chokepoint (Phase E T4) resolves it
      // — the events route refuses to mint a bus for a non-existent session id.
      const create = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await create.json()) as { sessionId: string };

      const bus = getOrCreateBus(sessionId);
      bus.publish({ type: 'text_delta', seq: bus.nextSeq(), sessionId, block: 0, text: 'Hello ' });
      bus.publish({ type: 'text_delta', seq: bus.nextSeq(), sessionId, block: 0, text: 'world.' });
      bus.publish({
        type: 'turn_complete',
        seq: bus.nextSeq(),
        sessionId,
        finishReason: 'end_turn',
      });

      const res = await app.request(`/sessions/${sessionId}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

      const body = await res.text();
      const blocks = body
        .split('\n\n')
        .map((b) => b.trim())
        .filter(Boolean)
        // Drop SSE comment frames (lines starting with ':') — the route emits a
        // leading ': connected' heartbeat to flush headers on connect.
        .filter((b) => !b.split('\n').every((l) => l.startsWith(':')));
      expect(blocks.length).toBeGreaterThanOrEqual(3);

      // Parse the JSON data field from each block.
      const events = blocks.map((b) => {
        const dataLine = b.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) throw new Error(`no data line in block: ${b}`);
        return parseServerEvent(dataLine.slice('data: '.length));
      });

      expect(events[0]?.type).toBe('text_delta');
      if (events[0]?.type !== 'text_delta') throw new Error('narrow');
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[0].text).toBe('Hello ');

      const last = events[events.length - 1];
      expect(last?.type).toBe('turn_complete');
    } finally {
      await runtime.dispose();
    }
  });

  // FIX 4 — a request whose signal is ALREADY aborted when the SSE handler
  // attaches must not leave a lingering subscriber pinning the session, and the
  // stream must end promptly rather than parking forever. The route pre-checks
  // the bus abort signal but had no symmetric request-signal pre-check, so an
  // early client disconnect (during the leading `await stream.write`, before the
  // abort handler registers) added the subscriber and never removed it.
  //
  // A `?follow` stream is the deterministic proxy: it never auto-ends on a turn
  // terminal and (with no replayed events) is not short-circuited by the
  // replay-count check, so without the pre-check the loop parks on the empty
  // queue forever — the leaked subscriber. We Promise.race against a timeout to
  // prove the stream actually completes, then assert no subscriber lingers.
  test('an already-aborted request signal (follow) ends promptly with no lingering subscriber', async () => {
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

      // Pre-create the bus so we can inspect its subscriber count afterwards
      // (the route uses getOrCreateBus, so this is the same instance).
      const bus = getOrCreateBus(sessionId);
      expect(bus.getSubscriberCount()).toBe(0);

      const ac = new AbortController();
      ac.abort();

      const work = (async (): Promise<'completed'> => {
        const res = await app.request(`/sessions/${sessionId}/events?follow=true`, {
          signal: ac.signal,
        });
        await res.text().catch(() => '');
        return 'completed';
      })();
      const outcome = await Promise.race<'completed' | 'timeout'>([
        work,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);

      // Without the fix this races to 'timeout' (the loop parks forever) and the
      // subscriber stays at 1.
      expect(outcome).toBe('completed');
      expect(bus.getSubscriberCount()).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });
});
