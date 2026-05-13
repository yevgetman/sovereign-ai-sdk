// Phase 16.1 — buildApp() is the runtime-less flavor used by boot tests
// for the health check. The full surface (sessions, turns, events) lives
// under buildAppWithRuntime so it can wire the per-session event bus and
// the configured provider.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildApp', () => {
  test('mounts /health', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  test('does not mount /sessions/:id/events without a runtime', async () => {
    const app = buildApp();
    const res = await app.request('/sessions/s_smoke/events');
    expect(res.status).toBe(404);
  });

  test('returns 404 for unknown routes', async () => {
    const app = buildApp();
    const res = await app.request('/no-such-route');
    expect(res.status).toBe(404);
  });
});

describe('buildAppWithRuntime', () => {
  test('mounts /health, /sessions, /sessions/:id/events', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-app-rt-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      const app = buildAppWithRuntime(runtime);

      expect((await app.request('/health')).status).toBe(200);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // The events route is mounted (we don't drain the SSE stream here
      // since there are no buffered events; just check the route exists
      // by hitting it after publishing a terminal event).
      const { getOrCreateBus } = await import('../../src/server/eventBus.js');
      const bus = getOrCreateBus(sessionId);
      bus.publish({
        type: 'turn_complete',
        seq: bus.nextSeq(),
        sessionId,
        finishReason: 'end_turn',
      });
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.headers.get('content-type')).toMatch(/text\/event-stream/);

      await runtime.dispose();
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
