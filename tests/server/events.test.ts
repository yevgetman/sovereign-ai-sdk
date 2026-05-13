import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { eventsRoute } from '../../src/server/routes/events.js';
import { parseServerEvent } from '../../src/server/schema.js';

describe('eventsRoute (M1 hardcoded)', () => {
  test('GET /sessions/:id/events emits text_delta then turn_complete', async () => {
    const app = new Hono().route('/', eventsRoute);
    const res = await app.request('/sessions/s_test/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await res.text();
    const blocks = body
      .split('\n\n')
      .map((b) => b.trim())
      .filter(Boolean);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    // Parse the JSON data field from each block.
    const events = blocks.map((b) => {
      const dataLine = b.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) throw new Error(`no data line in block: ${b}`);
      return parseServerEvent(dataLine.slice('data: '.length));
    });

    expect(events[0]?.type).toBe('text_delta');
    if (events[0]?.type !== 'text_delta') throw new Error('narrow');
    expect(events[0].sessionId).toBe('s_test');

    const last = events[events.length - 1];
    expect(last?.type).toBe('turn_complete');
  });
});
