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
import { WEB_UI_HTML } from '../../src/server/webui.js';

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

// FIX 5 — the embedded web UI is inline JS served as a static asset; there's no
// JS harness to execute its handlers here (a true behavioral check needs a
// browser/Playwright run, noted in the report). These structural assertions
// guard the load-bearing fix against silent regression: on a compaction session
// pivot the follow stream MUST be re-pointed at the child bus (reset
// lastEventId + stopStream + openStream), or every subsequent turn renders
// nothing — the conversation freezes.
describe('web UI compaction pivot re-points the follow stream (FIX 5)', () => {
  // Isolate the compactionNotice function body from the served HTML so the
  // assertions key on the handler, not incidental matches elsewhere.
  const compactionFn = (() => {
    const start = WEB_UI_HTML.indexOf('function compactionNotice(');
    expect(start).toBeGreaterThanOrEqual(0);
    // Take a generous slice — the function is short; the next `function ` after
    // it bounds the body.
    const after = WEB_UI_HTML.indexOf('function ', start + 'function compactionNotice('.length);
    return WEB_UI_HTML.slice(start, after === -1 ? start + 800 : after);
  })();

  test('updates S.sessionId on a child pivot', () => {
    expect(compactionFn).toContain('S.sessionId = ev.activeSessionId');
  });

  test('resets the reconnect cursor (lastEventId) so the child bus is read fresh', () => {
    expect(compactionFn).toContain('S.lastEventId = null');
  });

  test('reopens the stream against the child bus (stopStream + openStream)', () => {
    expect(compactionFn).toContain('stopStream()');
    expect(compactionFn).toContain('openStream()');
    // The reconnect must happen AFTER the session id is updated, or it would
    // reopen against the stale parent id.
    const pivotIdx = compactionFn.indexOf('S.sessionId = ev.activeSessionId');
    const openIdx = compactionFn.indexOf('openStream()');
    expect(openIdx).toBeGreaterThan(pivotIdx);
  });
});
