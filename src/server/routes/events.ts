// GET /sessions/:id/events — SSE stream of server events for a session.
//
// Phase 16.1 M3: consumes the per-session event bus populated by the turn
// handler. Events buffered before the subscriber attaches are drained
// immediately so a "POST /turns, then GET /events" sequence is well-defined
// without a sleep. The stream ends when turn_complete or turn_error arrives.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getOrCreateBus } from '../eventBus.js';
import type { ServerEvent } from '../schema.js';

export const eventsRoute = new Hono();

eventsRoute.get('/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');
  const bus = getOrCreateBus(sessionId);
  return streamSSE(c, async (stream) => {
    let stopped = false;
    const queue: ServerEvent[] = [];
    let resolver: (() => void) | null = null;
    const unsubscribe = bus.subscribe((ev) => {
      queue.push(ev);
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        r();
      }
    });
    try {
      while (!stopped) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolver = r;
          });
        }
        const ev = queue.shift();
        if (ev === undefined) continue;
        await stream.writeSSE({
          event: ev.type,
          id: String(ev.seq),
          data: JSON.stringify(ev),
        });
        if (ev.type === 'turn_complete' || ev.type === 'turn_error') {
          stopped = true;
        }
      }
    } finally {
      unsubscribe();
    }
  });
});
