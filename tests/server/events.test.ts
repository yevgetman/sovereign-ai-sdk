// Phase 16.1 M3 — events route consumes the per-session event bus.
// Test seeds the bus with synthetic events, GETs the SSE endpoint, and
// asserts the on-wire payload contains them plus a terminal turn_complete.

import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { __test_resetAllBuses, getOrCreateBus } from '../../src/server/eventBus.js';
import { eventsRoute } from '../../src/server/routes/events.js';
import { parseServerEvent } from '../../src/server/schema.js';

describe('eventsRoute (M3 bus-driven)', () => {
  test('GET /sessions/:id/events streams buffered bus events + terminal turn_complete', async () => {
    __test_resetAllBuses();
    const sessionId = 's_test';
    const bus = getOrCreateBus(sessionId);
    bus.publish({ type: 'text_delta', seq: bus.nextSeq(), sessionId, block: 0, text: 'Hello ' });
    bus.publish({ type: 'text_delta', seq: bus.nextSeq(), sessionId, block: 0, text: 'world.' });
    bus.publish({
      type: 'turn_complete',
      seq: bus.nextSeq(),
      sessionId,
      finishReason: 'end_turn',
    });

    const app = new Hono().route('/', eventsRoute);
    const res = await app.request(`/sessions/${sessionId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await res.text();
    const blocks = body
      .split('\n\n')
      .map((b) => b.trim())
      .filter(Boolean);
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
  });
});
