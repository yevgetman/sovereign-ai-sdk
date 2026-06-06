// Phase C T1 — embedded web UI shell served from the gateway.
//
// GET / and GET /ui serve the embedded HTML shell. Both are OPEN (no auth)
// — they carry no secret, they're just the browser client's shell — and are
// mounted BEFORE the bearer-auth middleware so they stay reachable without
// credentials, exactly like /health. The session routes stay bearer-gated.

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

describe('web UI shell — buildAppWithRuntime serves an open HTML shell', () => {
  test('GET / with no auth → 200 text/html containing the app marker', async () => {
    await withMockRuntime('ct1-root', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('id="app"');
    });
  });

  test('GET /ui with no auth → 200 text/html containing the app marker', async () => {
    await withMockRuntime('ct1-ui', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/ui');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('id="app"');
    });
  });

  test('POST /sessions with no auth → still 401 (auth unaffected by the open UI route)', async () => {
    await withMockRuntime('ct1-gated', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/sessions', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  test('GET /health with no auth → still 200 (open probe unaffected)', async () => {
    await withMockRuntime('ct1-health', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { auth: 'secret' });
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    });
  });
});
