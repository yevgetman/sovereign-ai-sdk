// Real-socket gateway integration test.
//
// Every other server test in this suite drives the Hono app via the in-memory
// `app.request()` helper. That bypasses real `Bun.serve` and therefore never
// exercises the seams that only exist over an actual TCP loopback connection:
//   - the real serving path (`startServer` → `Bun.serve` with `idleTimeout: 0`),
//   - CORS-header emission on a *streaming* SSE response (the ACAO header has to
//     ride out with the flushed response headers, not just on a buffered JSON
//     body),
//   - real client disconnect (aborting a `fetch()` mid-stream) and the bus
//     cleanup that must follow.
//
// This test stands up the gateway on a free loopback port with auth + a CORS
// allow-list, then drives it entirely through the global `fetch` against
// `http://127.0.0.1:<port>`. It is deterministic: the provider is MockProvider
// (default `Hello world.` stream — `message_start` → two `text_delta`s →
// `message_stop`), so a turn always produces `text_delta` then `turn_complete`
// with no network or model variance. The single SSE leg is opened with
// `?follow=true` so the test — not a turn terminal — owns when the stream
// closes (it aborts the fetch to simulate a client disconnect), which is what
// leg (e) needs to observe bus reclamation.
//
// Stability: a free port is bound per test, `server.stop()` runs in `finally`,
// MockProvider statics + all buses are reset in `afterEach`, and every wait is
// a bounded poll/await against an observable condition — no fixed sleeps that
// could race over a real socket.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { __test_busCount, __test_resetAllBuses } from '../../src/server/eventBus.js';
import { startServer } from '../../src/server/index.js';
import { buildRuntime } from '../../src/server/runtime.js';

const AUTH_TOKEN = 'itok';
const LISTED_ORIGIN = 'http://localhost:5599';
const UNLISTED_ORIGIN = 'http://evil.example';
const BEARER: Record<string, string> = { authorization: `Bearer ${AUTH_TOKEN}` };

type ParsedSse = { event: string; id: string | null; data: string | null };

/** Parse one `\n\n`-delimited SSE block into its event/id/data lines.
 *  Comment frames (`: connected`) and blocks with no `event:` line yield null. */
function parseSseBlock(block: string): ParsedSse | null {
  let event: string | null = null;
  let id: string | null = null;
  let data: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    else if (line.startsWith('id: ')) id = line.slice('id: '.length);
    else if (line.startsWith('data: ')) data = line.slice('data: '.length);
  }
  if (event === null) return null;
  return { event, id, data };
}

describe('gateway real-socket integration (auth + CORS-on-SSE + turn + disconnect cleanup)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gw-int-'));
    cwd = mkdtempSync(join(tmpdir(), 'gw-int-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = false;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    MockProvider.lastMessages = undefined;
    __test_resetAllBuses();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.slowMode = false;
    MockProvider.slowModeDelayMs = 0;
    MockProvider.lastMessages = undefined;
    __test_resetAllBuses();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('serves the UI, gates auth, emits CORS on a real SSE turn, and reclaims the bus on disconnect', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      // bypass: the happy-path turn must not park on a permission ask — the
      // default Hello-world stream issues no tool_use anyway, but this keeps
      // the turn deterministic regardless of any ambient permission rules.
      permissionMode: 'bypass',
      preflight: false,
      cronEnabled: false,
    });
    // Serve via the REAL gateway path: Bun.serve on a free loopback port, with
    // bearer auth + the CORS allow-list. port: 0 lets the OS pick a free port.
    const server = await startServer({
      runtime,
      port: 0,
      hostname: '127.0.0.1',
      auth: AUTH_TOKEN,
      corsOrigins: [LISTED_ORIGIN],
    });
    const base = `http://127.0.0.1:${server.port}`;

    try {
      // (a) GET / (the web UI shell) is open — no token required.
      const ui = await fetch(`${base}/`);
      expect(ui.status).toBe(200);
      expect((await ui.text()).length).toBeGreaterThan(0);

      // (b) POST /sessions is gated: 401 without a token, 201 with the bearer.
      const noAuth = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(noAuth.status).toBe(401);

      const created = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { ...BEARER, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(created.status).toBe(201);
      const { sessionId } = (await created.json()) as { sessionId: string };
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);

      // (c) Preflight OPTIONS from the listed origin returns the ACAO header on
      // a REAL response; a non-listed origin gets none. (CORS runs before auth,
      // so the preflight carries no bearer token — exactly how a browser sends
      // it.)
      const preflightListed = await fetch(`${base}/sessions`, {
        method: 'OPTIONS',
        headers: {
          Origin: LISTED_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Content-Type, Last-Event-ID',
        },
      });
      expect(preflightListed.headers.get('Access-Control-Allow-Origin')).toBe(LISTED_ORIGIN);
      // Drain the body so the connection is freed deterministically.
      await preflightListed.text();

      const preflightUnlisted = await fetch(`${base}/sessions`, {
        method: 'OPTIONS',
        headers: {
          Origin: UNLISTED_ORIGIN,
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(preflightUnlisted.headers.get('Access-Control-Allow-Origin')).toBeNull();
      await preflightUnlisted.text();

      // (d) A full turn over real sockets. Open the SSE stream FIRST (with
      // ?follow=true so it stays open across the turn terminal — the test owns
      // the close), carrying the bearer + the listed Origin. The events route
      // writes ': connected\n\n' before any event, which flushes the HTTP
      // response headers immediately — so the ACAO header is observable on the
      // streaming SSE response right after `await fetch(...)` resolves.
      const sseAbort = new AbortController();
      const sseRes = await fetch(`${base}/sessions/${sessionId}/events?follow=true`, {
        headers: { ...BEARER, Origin: LISTED_ORIGIN },
        signal: sseAbort.signal,
      });
      expect(sseRes.status).toBe(200);
      // CORS-on-SSE: the streaming response carries the ACAO header for the
      // listed origin. This is the seam app.request() can't prove — the header
      // must ride out with the flushed streaming response headers.
      expect(sseRes.headers.get('Access-Control-Allow-Origin')).toBe(LISTED_ORIGIN);
      if (sseRes.body === null) throw new Error('SSE response has no body');

      // Now submit the turn. The default Hello-world stream yields text_delta
      // then a turn terminal — deterministic, no model variance.
      const turn = await fetch(`${base}/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { ...BEARER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turn.status).toBe(202);

      // Consume the SSE body reader until BOTH text_delta and turn_complete are
      // seen, bounded by a deadline so a regression fails fast instead of
      // hanging the suite.
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      const seen = new Set<string>();
      let buffer = '';
      const deadline = Date.now() + 10_000;
      try {
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf('\n\n');
          while (idx !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const parsed = parseSseBlock(block);
            if (parsed !== null) seen.add(parsed.event);
            idx = buffer.indexOf('\n\n');
          }
          if (seen.has('text_delta') && seen.has('turn_complete')) break;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // releaseLock can throw if the reader is already released; ignore.
        }
      }
      expect(seen.has('text_delta')).toBe(true);
      expect(seen.has('turn_complete')).toBe(true);

      // (e) Client disconnect: abort the follow fetch (the real-socket
      // equivalent of a browser closing the tab mid-stream), then dispose the
      // runtime. dispose() aborts + clears every session bus, so once it
      // returns the bus registry is empty — no leak.
      sseAbort.abort();
      await runtime.dispose();
      expect(__test_busCount()).toBe(0);
    } finally {
      await server.stop();
      // dispose() is idempotent on its bus walk; if the happy path didn't reach
      // it (an assertion threw earlier), make sure the runtime is torn down so
      // the DB handle + cron tick don't leak across tests.
      try {
        await runtime.dispose();
      } catch {
        // already disposed — the second call is a no-op-ish best effort.
      }
    }
  }, 20_000);

  // Phase F-T7 — the gateway mounts the OPEN channel routes when `channels` is
  // passed to startServer (the path runGateway takes). Over a REAL socket: a
  // configured webhook channel is reachable (a bad signature is 401, NOT a
  // 404-route-missing), and a request to an UNKNOWN channel id is 404
  // (existence-hiding). This proves the startServer → buildAppWithRuntime
  // channels threading, which the in-memory app.request() mount test can't show
  // over a live Bun.serve.
  test('startServer({ channels }) mounts the open webhook route over a real socket', async () => {
    const runtime = await buildRuntime({
      cwd,
      harnessHome: home,
      provider: 'mock',
      permissionMode: 'bypass',
      preflight: false,
      cronEnabled: false,
    });
    const server = await startServer({
      runtime,
      port: 0,
      hostname: '127.0.0.1',
      auth: AUTH_TOKEN,
      channels: { webhook: { enabled: true, secret: 'whsec', principalId: 'wh' } },
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      // The webhook route is OPEN (no gateway bearer needed) but verifies its own
      // HMAC: a bad signature is 401, proving the route is MOUNTED (not 404).
      const badSig = await fetch(`${base}/channels/webhook/default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' },
        body: JSON.stringify({ sender: 'u1', text: 'hi' }),
      });
      expect(badSig.status).toBe(401);

      // An unknown channel id is 404 (the route exists but hides which channels do).
      const unknownId = await fetch(`${base}/channels/webhook/nope`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' },
        body: JSON.stringify({ sender: 'u1', text: 'hi' }),
      });
      expect(unknownId.status).toBe(404);
    } finally {
      await server.stop();
      try {
        await runtime.dispose();
      } catch {
        // already disposed.
      }
    }
  }, 20_000);
});
