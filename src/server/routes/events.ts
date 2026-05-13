// GET /sessions/:id/events — SSE stream of server events for a session.
//
// Phase 16.1 M3: consumes the per-session event bus populated by the turn
// handler. Events buffered before the subscriber attaches are drained
// immediately so a "POST /turns, then GET /events" sequence is well-defined
// without a sleep. The stream ends when turn_complete or turn_error arrives,
// or when the client disconnects (c.req.raw.signal aborts the parked Promise).

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { disposeBus, getOrCreateBus } from '../eventBus.js';
import type { ServerEvent } from '../schema.js';
import { isValidSessionId } from '../sessionId.js';

export const eventsRoute = new Hono();

eventsRoute.get('/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'invalid session id' }, 400);
  }
  const bus = getOrCreateBus(sessionId);
  const requestSignal = c.req.raw.signal;
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
    // Without this listener the loop can park forever on the empty-queue
    // Promise: a client disconnect with no pending events leaves nothing
    // to invoke the resolver, so `unsubscribe()` and `disposeBus()` never
    // run and the bus map leaks.
    const abortHandler = (): void => {
      stopped = true;
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        r();
      }
    };
    requestSignal.addEventListener('abort', abortHandler);
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
      requestSignal.removeEventListener('abort', abortHandler);
      unsubscribe();
      // After the stream closes (turn_complete / turn_error / client
      // disconnect), the bus has delivered everything for this turn.
      // Drop it from the map so the session's memory footprint doesn't
      // leak. Resume across reconnects (M9+) needs a different lifecycle.
      disposeBus(sessionId);
    }
  });
});
