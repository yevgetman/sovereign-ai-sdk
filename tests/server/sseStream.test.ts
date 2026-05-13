import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { ServerEvent } from '../../src/server/schema.js';
import { mountEventStream } from '../../src/server/sseStream.js';

async function* fakeEvents(): AsyncGenerator<ServerEvent> {
  yield { type: 'text_delta', seq: 1, sessionId: 's_test', block: 0, text: 'Hello' };
  yield { type: 'text_delta', seq: 2, sessionId: 's_test', block: 0, text: ' world' };
  yield {
    type: 'turn_complete',
    seq: 3,
    sessionId: 's_test',
    finishReason: 'end_turn',
  };
}

describe('mountEventStream', () => {
  test('emits each event as a single SSE data: line with the event type', async () => {
    const app = new Hono();
    app.get('/stream', (c) => mountEventStream(c, fakeEvents));

    const res = await app.request('/stream');
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await res.text();

    // Expect three data: blocks with event: prefixes.
    const blocks = body
      .split('\n\n')
      .map((b) => b.trim())
      .filter(Boolean);
    expect(blocks.length).toBe(3);

    // First block: event: text_delta\nid: 1\ndata: {"type":"text_delta", ...}
    expect(blocks[0]).toContain('event: text_delta');
    expect(blocks[0]).toContain('id: 1');
    expect(blocks[0]).toContain('"text":"Hello"');

    // Last block: turn_complete
    expect(blocks[2]).toContain('event: turn_complete');
    expect(blocks[2]).toContain('id: 3');
  });
});
