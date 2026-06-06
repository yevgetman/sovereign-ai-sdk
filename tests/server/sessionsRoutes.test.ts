// Phase D T4 — session-management routes + concurrency cap.
//
// Covers the additive surface on the sessions route module:
//   - GET /sessions — list sessions with live/turnActive/subscribers annotations.
//   - DELETE /sessions/:id — tear down + delete a single session.
//   - POST /sessions cap — refuse with 429 once a supervisor reports the live
//     count is at the configured concurrency ceiling (after a sweep fails to
//     free room); succeed when the sweep frees room.
//
// All built with a MockProvider runtime + buildAppWithRuntime + app.request,
// mirroring auth.test.ts / gatewayEndToEnd.test.ts. The fake supervisor is a
// minimal structural stand-in so the cap path is exercised without arming the
// real SessionSupervisor's timers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses, getOrCreateBus, peekBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';

const AUTH_TOKEN = 'secret';
const BEARER: Record<string, string> = { authorization: `Bearer ${AUTH_TOKEN}` };

async function withMockRuntime(
  label: string,
  fn: (runtime: Awaited<ReturnType<typeof buildRuntime>>) => Promise<void>,
): Promise<void> {
  const home = join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
  try {
    runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
      preflight: false,
    });
    await fn(runtime);
  } finally {
    if (runtime !== null) await runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}

async function createSession(
  app: ReturnType<typeof buildAppWithRuntime>,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await app.request('/sessions', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return sessionId;
}

type ListedSession = {
  sessionId: string;
  createdAt: number;
  live: boolean;
  turnActive: boolean;
  subscribers: number;
};

beforeEach(() => {
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  __test_resetAllBuses();
});

afterEach(() => {
  __test_resetAllBuses();
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  delete process.env.SOV_TEST_MOCK_PROVIDER;
});

describe('GET /sessions — list with live annotations (T4)', () => {
  test('returns 200 { sessions: [...] } with both created sessions and their annotations', async () => {
    await withMockRuntime('t4-list', async (runtime) => {
      const app = buildAppWithRuntime(runtime);
      const idA = await createSession(app);
      const idB = await createSession(app);

      // Seed session A a live bus + a subscriber; leave B with no bus.
      const busA = getOrCreateBus(idA);
      busA.subscribe(() => {});

      const res = await app.request('/sessions');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: ListedSession[] };
      expect(Array.isArray(body.sessions)).toBe(true);

      const entryA = body.sessions.find((s) => s.sessionId === idA);
      const entryB = body.sessions.find((s) => s.sessionId === idB);
      expect(entryA).toBeDefined();
      expect(entryB).toBeDefined();
      if (entryA === undefined || entryB === undefined) throw new Error('missing entry');

      // Every entry carries sessionId + createdAt + the three annotations.
      expect(typeof entryA.sessionId).toBe('string');
      expect(typeof entryA.createdAt).toBe('number');

      // A: live bus with one subscriber, no active turn.
      expect(entryA.live).toBe(true);
      expect(entryA.subscribers).toBe(1);
      expect(entryA.turnActive).toBe(false);

      // B: no bus → not live, no subscribers.
      expect(entryB.live).toBe(false);
      expect(entryB.subscribers).toBe(0);
      expect(entryB.turnActive).toBe(false);
    });
  });

  test('with auth set → 401 without a token, 200 with the token', async () => {
    await withMockRuntime('t4-list-auth', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: AUTH_TOKEN });

      const noAuth = await app.request('/sessions');
      expect(noAuth.status).toBe(401);

      const withAuth = await app.request('/sessions', { headers: BEARER });
      expect(withAuth.status).toBe(200);
    });
  });
});

describe('DELETE /sessions/:id (T4)', () => {
  test('deletes a session (with a live bus) → 204; then GET 404 + peekBus undefined', async () => {
    await withMockRuntime('t4-del', async (runtime) => {
      const app = buildAppWithRuntime(runtime);
      const id = await createSession(app);
      // Give it a live bus so we also prove disposeBus runs.
      getOrCreateBus(id);
      expect(peekBus(id)).toBeDefined();

      const del = await app.request(`/sessions/${id}`, { method: 'DELETE' });
      expect(del.status).toBe(204);

      const get = await app.request(`/sessions/${id}`);
      expect(get.status).toBe(404);
      expect(peekBus(id)).toBeUndefined();
    });
  });

  test('DELETE of an unknown (valid-format) id → 404', async () => {
    await withMockRuntime('t4-del-unknown', async (runtime) => {
      const app = buildAppWithRuntime(runtime);
      // A valid-format session id that was never created.
      const unknown = '00000000-0000-4000-8000-000000000000';
      const del = await app.request(`/sessions/${unknown}`, { method: 'DELETE' });
      expect(del.status).toBe(404);
    });
  });

  test('DELETE of a malformed id → 400', async () => {
    await withMockRuntime('t4-del-bad', async (runtime) => {
      const app = buildAppWithRuntime(runtime);
      // 'bad id!' contains characters outside [A-Za-z0-9_-] — the canonical
      // malformed-id fixture used across compact/cancel route tests.
      const del = await app.request('/sessions/bad%20id!', { method: 'DELETE' });
      expect(del.status).toBe(400);
    });
  });

  test('with auth set → 401 without a token', async () => {
    await withMockRuntime('t4-del-auth', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: AUTH_TOKEN });
      const id = await createSession(app, BEARER);
      const noAuth = await app.request(`/sessions/${id}`, { method: 'DELETE' });
      expect(noAuth.status).toBe(401);
    });
  });
});

describe('POST /sessions — concurrency cap (T4)', () => {
  test('cap reached + sweep frees nothing → 429 { error }', async () => {
    await withMockRuntime('t4-cap-429', async (runtime) => {
      const supervisor = {
        liveSessionCount: () => 1,
        sweep: async () => ({ evicted: [] as string[], skipped: 0 }),
        getMaxConcurrentSessions: () => 1,
      };
      const app = buildAppWithRuntime(runtime, { supervisor });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe('string');
    });
  });

  test('max of 0 → cap disabled, 201 as today', async () => {
    await withMockRuntime('t4-cap-zero', async (runtime) => {
      const supervisor = {
        liveSessionCount: () => 999,
        sweep: async () => ({ evicted: [] as string[], skipped: 0 }),
        getMaxConcurrentSessions: () => 0,
      };
      const app = buildAppWithRuntime(runtime, { supervisor });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
    });
  });

  test('no supervisor → cap disabled, 201 as today', async () => {
    await withMockRuntime('t4-cap-none', async (runtime) => {
      const app = buildAppWithRuntime(runtime);
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
    });
  });

  test('over cap on first check but sweep frees room → POST succeeds (201)', async () => {
    await withMockRuntime('t4-cap-sweep', async (runtime) => {
      // liveSessionCount returns 1 (>= max) on the first check, then 0 after
      // sweep() runs — proving the sweep-then-recheck path admits the request.
      let count = 1;
      const supervisor = {
        liveSessionCount: () => count,
        sweep: async () => {
          count = 0;
          return { evicted: ['someone'], skipped: 0 };
        },
        getMaxConcurrentSessions: () => 1,
      };
      const app = buildAppWithRuntime(runtime, { supervisor });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
    });
  });
});
