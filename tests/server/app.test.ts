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

  // GET /conduct/overlay — the directive-overlay intake verdict. Mounted ONLY
  // when an overlay was bound at boot, so a host can report a refused directive
  // to the user instead of it silently never applying.
  describe('GET /conduct/overlay', () => {
    async function withRuntime<T>(
      fn: (runtime: Awaited<ReturnType<typeof buildRuntime>>) => Promise<T>,
    ): Promise<T> {
      const home = mkdtempSync(join(tmpdir(), 'sov-app-overlay-'));
      process.env.SOV_TEST_MOCK_PROVIDER = '1';
      try {
        const runtime = await buildRuntime({
          harnessHome: home,
          cwd: process.cwd(),
          provider: 'mock',
          model: 'mock-haiku',
        });
        const out = await fn(runtime);
        await runtime.dispose();
        return out;
      } finally {
        // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
        delete process.env.SOV_TEST_MOCK_PROVIDER;
        rmSync(home, { recursive: true, force: true });
      }
    }

    test('serves the content-free intake when an overlay was bound', async () => {
      await withRuntime(async (runtime) => {
        const app = buildAppWithRuntime(runtime, {
          overlayIntake: {
            accepted: 2,
            rejected: [{ channel: 'instruction', index: 1, reasonCode: 'injection' }],
          },
        });
        const res = await app.request('/conduct/overlay');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          accepted: 2,
          rejected: [{ channel: 'instruction', index: 1, reasonCode: 'injection' }],
        });
      });
    });

    test('is NOT mounted when no overlay was bound (byte-unchanged)', async () => {
      await withRuntime(async (runtime) => {
        const app = buildAppWithRuntime(runtime);
        expect((await app.request('/conduct/overlay')).status).toBe(404);
      });
    });

    test('is gated by the same bearer auth as the session routes', async () => {
      await withRuntime(async (runtime) => {
        const app = buildAppWithRuntime(runtime, {
          auth: 'secret-token',
          overlayIntake: { accepted: 1, rejected: [] },
        });
        expect((await app.request('/conduct/overlay')).status).toBe(401);
        const ok = await app.request('/conduct/overlay', {
          headers: { authorization: 'Bearer secret-token' },
        });
        expect(ok.status).toBe(200);
      });
    });
  });
});
