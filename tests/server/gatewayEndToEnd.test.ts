// Phase A T7 — end-to-end authenticated turn over the native HTTP+SSE protocol.
//
// T3 (auth.test.ts) proved the bearer middleware gates POST /sessions and that
// /health stays open. This test goes further: it proves a FULL interactive turn
// works end-to-end while authenticated — mint session → subscribe SSE →
// submit a turn → drain events → answer a permission_request → reach
// turn_complete — with `Authorization: Bearer secret` on EVERY request,
// including the SSE GET (which lives under the auth-gated `/sessions/*`).
//
// It also re-proves enforcement at turn time: the SAME calls WITHOUT the token
// return 401 at POST /sessions, POST /sessions/:id/turns, and
// POST /sessions/:id/approvals/:id, while GET /health stays 200.
//
// The turn deliberately exercises the permission round-trip (the harder, more
// load-bearing proof): with permissionMode='ask' and a project-local ask rule
// on the exact command the mock provider issues, the turn parks on a
// permission_request, we approve it over the authenticated approvals route,
// and the tool then dispatches and the turn finishes — proving the auth'd
// approval handshake actually unparks an in-flight turn.
//
// SSE-reading mirrors turns.permission.test.ts: ONE subscription is kept alive
// end-to-end (disposing it mid-turn would abort the bus signal query() rides,
// tearing down the in-flight turn before the approval lands). The helper here
// adds a `headers` arg so the SSE GET can carry the bearer token.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { type ServerEvent, parseServerEvent } from '../../src/server/schema.js';

const AUTH_TOKEN = 'secret';
const BEARER: Record<string, string> = { authorization: `Bearer ${AUTH_TOKEN}` };

type SseEvent = {
  event: string;
  data: ServerEvent | null;
};

function parseSseBlock(block: string): SseEvent | null {
  let eventName: string | null = null;
  let dataLine: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) {
      eventName = line.slice('event: '.length);
    } else if (line.startsWith('data: ')) {
      dataLine = line.slice('data: '.length);
    }
  }
  if (eventName === null) return null;
  const parsed = dataLine !== null ? parseServerEvent(dataLine) : null;
  return { event: eventName, data: parsed };
}

type SseHandle = {
  events: SseEvent[];
  done: Promise<void>;
  onEvent: (cb: (ev: SseEvent) => void) => void;
};

/** Open one SSE subscription, draining in a background loop so the test can
 *  POST approvals concurrently. `headers` carries the bearer token — the SSE
 *  GET lives under the auth-gated `/sessions/*`, so the subscription itself
 *  must authenticate. Resolves `done` when `stopWhen` matches or the stream
 *  ends. (Helper shape mirrors turns.permission.test.ts, plus the headers arg.) */
function openSse(
  app: ReturnType<typeof buildAppWithRuntime>,
  sessionId: string,
  stopWhen: (ev: SseEvent) => boolean,
  headers: Record<string, string> = {},
): SseHandle {
  const events: SseEvent[] = [];
  const listeners: Array<(ev: SseEvent) => void> = [];
  const done = (async (): Promise<void> => {
    const res = await app.request(`/sessions/${sessionId}/events`, { headers });
    if (res.status !== 200) {
      throw new Error(`SSE GET failed: ${res.status}`);
    }
    if (res.body === null) {
      throw new Error('SSE response has no body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let blockEnd = buffer.indexOf('\n\n');
        let stopHit = false;
        while (blockEnd !== -1) {
          const block = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          const parsed = parseSseBlock(block);
          if (parsed !== null) {
            events.push(parsed);
            for (const fn of listeners) fn(parsed);
            if (stopWhen(parsed)) {
              stopHit = true;
              break;
            }
          }
          blockEnd = buffer.indexOf('\n\n');
        }
        if (stopHit) break;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore: releaseLock can throw if the reader is already closed
      }
    }
  })();
  return {
    events,
    done,
    onEvent: (cb): void => {
      listeners.push(cb);
    },
  };
}

describe('gateway end-to-end — authenticated turn over the native protocol (T7)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 't7-gw-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 't7-gw-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = true;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.lastMessages = undefined;
    __test_resetAllBuses();
    // Project-local ask rule on the exact command the mock provider issues
    // (Bash echo hello-from-mock). Without it Bash self-allows "echo" and the
    // ask path never fires; the rule-layer `ask` outcome overrides the
    // tool's self-allow per canUseTool precedence.
    mkdirSync(join(tmpCwd, '.harness'), { recursive: true });
    writeFileSync(
      join(tmpCwd, '.harness', 'settings.json'),
      JSON.stringify({
        permissions: {
          ask: ['Bash(echo hello-from-mock)'],
          allow: [],
          deny: [],
        },
      }),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    MockProvider.toolUseMode = false;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.lastMessages = undefined;
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('authenticated turn completes end-to-end, including the permission round-trip', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      permissionMode: 'ask',
      preflight: false,
    });
    // Build WITH auth — every /sessions/* call must now present the token.
    const app = buildAppWithRuntime(runtime, { auth: AUTH_TOKEN });

    try {
      // Mint a session (authenticated).
      const create = await app.request('/sessions', {
        method: 'POST',
        headers: { ...BEARER, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(create.status).toBe(201);
      const { sessionId } = (await create.json()) as { sessionId: string };

      // Submit a turn (authenticated). The mock parks on the ask callback as
      // soon as it yields its first tool_use.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { ...BEARER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'echo hello' }),
      });
      expect(turnRes.status).toBe(202);

      // ONE authenticated SSE subscription that runs to turn_complete /
      // turn_error. Approve the permission request the instant it arrives —
      // that unparks the turn so the tool dispatches and turn_complete fires.
      const sse = openSse(
        app,
        sessionId,
        (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
        BEARER,
      );
      let approvalSent = false;
      let approvalResponseStatus = 0;
      sse.onEvent((ev) => {
        if (approvalSent) return;
        if (ev.event !== 'permission_request') return;
        if (ev.data === null || ev.data.type !== 'permission_request') return;
        approvalSent = true;
        // Approve over the AUTHENTICATED approvals route. Fire-and-let the
        // SSE loop keep draining; await the status after `sse.done` resolves.
        void Promise.resolve(
          app.request(`/sessions/${sessionId}/approvals/${ev.data.requestId}`, {
            method: 'POST',
            headers: { ...BEARER, 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: true }),
          }),
        ).then((res: Response) => {
          approvalResponseStatus = res.status;
        });
      });
      await sse.done;

      // The authenticated approval round-trip actually happened and was accepted.
      expect(approvalSent).toBe(true);
      expect(approvalResponseStatus).toBe(200);

      // The permission event surfaced with the expected tool + a real requestId.
      const permReq = sse.events.find((e) => e.event === 'permission_request');
      expect(permReq).toBeDefined();
      if (!permReq || permReq.data === null || permReq.data.type !== 'permission_request') {
        throw new Error('permission_request event missing or malformed');
      }
      expect(permReq.data.tool).toBe('Bash');
      expect(typeof permReq.data.requestId).toBe('string');
      expect(permReq.data.requestId.length).toBeGreaterThan(0);

      // The streamed events arrived and the turn reached turn_complete with no error.
      const turnComplete = sse.events.find((e) => e.event === 'turn_complete');
      expect(turnComplete).toBeDefined();
      expect(sse.events.find((e) => e.event === 'turn_error')).toBeUndefined();

      // Ordering: permission_request must precede turn_complete.
      const permIdx = sse.events.indexOf(permReq);
      const completeIdx = sse.events.findIndex((e) => e.event === 'turn_complete');
      expect(completeIdx).toBeGreaterThan(permIdx);

      // The tool actually dispatched post-approval — a tool_result event proves
      // the auth'd round-trip didn't merely emit the request and bail.
      const toolResult = sse.events.find((e) => e.event === 'tool_result');
      expect(toolResult).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 15_000);

  test('auth is enforced — /sessions/* require the token; /health stays open', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      permissionMode: 'ask',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime, { auth: AUTH_TOKEN });

    try {
      // GET /health → 200 with no token (probe-friendly, mounted before auth).
      const health = await app.request('/health');
      expect(health.status).toBe(200);

      // POST /sessions with NO token → 401.
      const createNoAuth = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(createNoAuth.status).toBe(401);

      // Mint a real session WITH the token so we have a concrete id to probe
      // the turns + approvals routes (proving they 401 on the path itself,
      // not just because the session doesn't exist).
      const create = await app.request('/sessions', {
        method: 'POST',
        headers: { ...BEARER, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(create.status).toBe(201);
      const { sessionId } = (await create.json()) as { sessionId: string };

      // POST /sessions/:id/turns with NO token → 401.
      const turnNoAuth = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'echo hello' }),
      });
      expect(turnNoAuth.status).toBe(401);

      // POST /sessions/:id/approvals/:id with NO token → 401 (any /sessions/*).
      const approvalNoAuth = await app.request(
        `/sessions/${sessionId}/approvals/req-does-not-matter`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        },
      );
      expect(approvalNoAuth.status).toBe(401);

      // GET /sessions/:id/events with NO token → 401 (the SSE subscription is gated too).
      const eventsNoAuth = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsNoAuth.status).toBe(401);
    } finally {
      await runtime.dispose();
    }
  });
});
