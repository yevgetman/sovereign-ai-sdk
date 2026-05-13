// GET /sessions/:id/events — SSE event stream for a session.
//
// M1 emits a hardcoded sequence so the Go TUI has something to render
// during scaffold-up. M3 wires this to a real query() turn.

import { Hono } from 'hono';
import type { ServerEvent } from '../schema.js';
import { mountEventStream } from '../sseStream.js';

export const eventsRoute = new Hono();

eventsRoute.get('/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');
  return mountEventStream(c, () => hardcodedStream(sessionId));
});

async function* hardcodedStream(sessionId: string): AsyncGenerator<ServerEvent> {
  // Three text deltas + a turn_complete. Pause briefly so the client sees
  // streaming, not a single-shot blob.
  const lines = ['Hello from ', 'the M1 ', 'placeholder stream.'];
  let seq = 1;
  for (const text of lines) {
    yield { type: 'text_delta', seq: seq++, sessionId, block: 0, text };
    await new Promise((r) => setTimeout(r, 25));
  }
  yield { type: 'turn_complete', seq: seq++, sessionId, finishReason: 'end_turn' };
}
