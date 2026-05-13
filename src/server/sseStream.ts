// SSE adapter: takes an async-generator of ServerEvent and writes them to a
// Hono response as standard `event: <type>` / `id: <seq>` / `data: <json>`
// blocks separated by blank lines. Hono's streamSSE handles the wire format,
// flush semantics, and proxy-friendly headers; we own the event-shape mapping.

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerEvent } from './schema.js';

export async function mountEventStream(
  c: Context,
  source: () => AsyncGenerator<ServerEvent>,
): Promise<Response> {
  return streamSSE(c, async (stream) => {
    for await (const event of source()) {
      await stream.writeSSE({
        event: event.type,
        id: String(event.seq),
        data: JSON.stringify(event),
      });
    }
  });
}
