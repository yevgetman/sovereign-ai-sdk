// Phase 16.1 M3.4 — server-side turn submission.
// POST /sessions creates a session in the in-memory store. POST /sessions/:id/turns
// kicks a query() loop against the mock provider; events stream over SSE.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('POST /sessions + POST /sessions/:id/turns', () => {
  test('creates a session, accepts a turn POST, streams events over SSE', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-turns-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      const app = buildAppWithRuntime(runtime);

      // Create a session.
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { sessionId: string };
      expect(typeof created.sessionId).toBe('string');
      expect(created.sessionId.length).toBeGreaterThan(0);
      const sessionId = created.sessionId;

      // Subscribe to the SSE stream BEFORE submitting the turn so the
      // first text_delta is observable. The mock provider streams
      // synchronously; the bus buffers until the subscriber attaches,
      // so the order of these two steps does not change the assertion.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.headers.get('content-type')).toMatch(/text\/event-stream/);
      const body = await eventsRes.text();

      // The mock provider yields two text_deltas ('Hello' + ' world.') then
      // a message_stop. The route maps text_delta -> text_delta and
      // message_stop -> turn_complete. So we expect at minimum: a
      // text_delta and a terminal turn_complete.
      expect(body).toContain('event: text_delta');
      expect(body).toContain('"text":"Hello"');
      expect(body).toContain('event: turn_complete');

      await runtime.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
