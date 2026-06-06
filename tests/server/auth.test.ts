// Phase A T3 — bearer auth middleware for the native HTTP+SSE protocol.
//
// Mirrors the OpenAI-server auth: /health stays open; /sessions/* is gated
// only when buildAppWithRuntime is given an `auth` token. The no-options
// default MUST be byte-unchanged so the existing TUI/serve/drive loopback
// path keeps working without credentials.

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

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
    });
    await fn(runtime);
  } finally {
    if (runtime !== null) await runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('native protocol bearer auth — buildAppWithRuntime({ auth })', () => {
  test('GET /health is open even when auth is set', async () => {
    await withMockRuntime('t3-health', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    });
  });

  test('POST /sessions with no Authorization header → 401', async () => {
    await withMockRuntime('t3-noauth', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/sessions', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  test('POST /sessions with a wrong bearer token → 401', async () => {
    await withMockRuntime('t3-wrong', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    });
  });

  test('POST /sessions with the correct bearer token → 2xx', async () => {
    await withMockRuntime('t3-ok', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      });
      expect(res.status).toBe(201);
    });
  });
});

describe('native protocol — no-options default is unchanged', () => {
  test('POST /sessions with no auth is NOT 401 when no options are given', async () => {
    await withMockRuntime('t3-default', async (runtime) => {
      const app = buildAppWithRuntime(runtime);
      const res = await app.request('/sessions', { method: 'POST' });
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(201);
    });
  });
});

describe('native protocol principal auth — buildAppWithRuntime({ principals })', () => {
  const principals = [
    { id: 'alice', token: 'tok-a' },
    { id: 'bob', token: 'tok-b' },
  ];

  test('GET /sessions with a resolving bearer token → NOT 401', async () => {
    await withMockRuntime('et2-ok-a', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { principals });
      const res = await app.request('/sessions', {
        headers: { authorization: 'Bearer tok-a' },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(200);
    });
  });

  test('GET /sessions with the other principal token also passes', async () => {
    await withMockRuntime('et2-ok-b', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { principals });
      const res = await app.request('/sessions', {
        headers: { authorization: 'Bearer tok-b' },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(200);
    });
  });

  test('GET /sessions with no Authorization header → 401 (no anonymous bypass)', async () => {
    await withMockRuntime('et2-noauth', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { principals });
      const res = await app.request('/sessions');
      expect(res.status).toBe(401);
    });
  });

  test('GET /sessions with a wrong bearer token → 401', async () => {
    await withMockRuntime('et2-wrong', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { principals });
      const res = await app.request('/sessions', {
        headers: { authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    });
  });
});
