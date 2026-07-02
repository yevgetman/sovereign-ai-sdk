// Phase 16.1 M5 T5 — permission-request round-trip integration test.
//
// Exercises the full bridge: with permissionMode='ask' a tool-using turn
// must (1) emit a `permission_request` SSE event with a fresh requestId,
// (2) pause the turn on the matching ApprovalQueue entry, (3) resume on
// POST /sessions/:id/approvals/:requestId, and (4) finish with the usual
// `turn_complete`. Regression target: the M3 deny-placeholder, which short-
// circuited every ask-mode tool call to `deny` without ever publishing a
// permission_request event.
//
// SSE-reading: a small streaming parser lives here (no shared helper in the
// suite as of T5). The test keeps ONE SSE subscription alive end-to-end —
// disposing the bus mid-turn would abort the bus's own AbortSignal (which is
// the cancellation signal `query()` receives), tearing down the in-flight
// turn before the approval can land. The helper reads chunks, parses
// `event:` / `data:` lines, and fires a callback after each event so the
// test can POST the approval while the stream keeps draining.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { type ServerEvent, parseServerEvent } from '../../src/server/schema.js';

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

/** Open one SSE subscription. Returns a handle that exposes the accumulated
 *  events plus a Promise resolved when either `stopWhen` matches an event or
 *  the stream ends. Callers MUST await `done` before assertions — the helper
 *  guarantees all events up to the stop point have been parsed and pushed
 *  into `events`. Internally pumps the body in a background async loop so
 *  the test thread can POST approvals concurrently. */
type SseHandle = {
  events: SseEvent[];
  done: Promise<void>;
  onEvent: (cb: (ev: SseEvent) => void) => void;
};

function openSse(
  app: ReturnType<typeof buildAppWithRuntime>,
  sessionId: string,
  stopWhen: (ev: SseEvent) => boolean,
): SseHandle {
  const events: SseEvent[] = [];
  const listeners: Array<(ev: SseEvent) => void> = [];
  const done = (async (): Promise<void> => {
    const res = await app.request(`/sessions/${sessionId}/events`);
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

describe('turns route — permission round-trip via serverAsk (M5 T5)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-perm-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-perm-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = true;
    __test_resetAllBuses();
    // Drop a project-local settings.json that adds an `ask` rule on the
    // exact Bash command the mock provider issues. Without this, Bash's
    // self-check returns `allow` ("echo" is on the read-only allowlist)
    // and the ask path never fires. The rule-layer `ask` outcome
    // overrides a tool's self-allow per canUseTool's precedence rules.
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
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('emits permission_request, awaits approval, then continues to turn_complete', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      permissionMode: 'ask',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const create = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };

    // POST /turns. The turn parks on the ask callback as soon as the
    // mock provider yields its first tool_use.
    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'echo hello' }),
    });
    expect(turnRes.status).toBe(202);

    // Open ONE SSE subscription that runs to turn_complete / turn_error.
    // Approve the permission request the moment it arrives — that's what
    // unparks the turn so it can continue, dispatch the tool, and
    // eventually emit turn_complete.
    const sse = openSse(
      app,
      sessionId,
      (ev) => ev.event === 'turn_complete' || ev.event === 'turn_error',
    );
    let approvalSent = false;
    let approvalResponseStatus = 0;
    sse.onEvent((ev) => {
      if (approvalSent) return;
      if (ev.event !== 'permission_request') return;
      if (ev.data === null || ev.data.type !== 'permission_request') return;
      approvalSent = true;
      // Fire and let the SSE loop keep reading; we await the response
      // explicitly after `sse.done` resolves to surface any HTTP error.
      // app.request() can return Response | Promise<Response>; wrap in
      // Promise.resolve to normalize the async chain.
      void Promise.resolve(
        app.request(`/sessions/${sessionId}/approvals/${ev.data.requestId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        }),
      ).then((res: Response) => {
        approvalResponseStatus = res.status;
      });
    });
    await sse.done;

    // Sanity: the approval round-trip actually happened.
    expect(approvalSent).toBe(true);
    expect(approvalResponseStatus).toBe(200);

    // Permission event surfaced with the expected tool name + a valid
    // requestId. Sequence: the event must appear BEFORE turn_complete.
    const permReq = sse.events.find((e) => e.event === 'permission_request');
    expect(permReq).toBeDefined();
    if (!permReq || permReq.data === null || permReq.data.type !== 'permission_request') {
      throw new Error('permission_request event missing or malformed');
    }
    expect(permReq.data.tool).toBe('Bash');
    expect(typeof permReq.data.requestId).toBe('string');
    expect(permReq.data.requestId.length).toBeGreaterThan(0);

    // Turn finished normally — the tool actually ran post-approval.
    const turnComplete = sse.events.find((e) => e.event === 'turn_complete');
    expect(turnComplete).toBeDefined();
    expect(sse.events.find((e) => e.event === 'turn_error')).toBeUndefined();

    // Ordering: permission_request must arrive before turn_complete.
    const permIdx = sse.events.indexOf(permReq);
    const completeIdx = sse.events.findIndex((e) => e.event === 'turn_complete');
    expect(permIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(permIdx);

    // The tool actually dispatched after approval — tool_result with the
    // mock's echo output proves the round-trip didn't just emit the event
    // and bail.
    const toolResult = sse.events.find((e) => e.event === 'tool_result');
    expect(toolResult).toBeDefined();

    await runtime.dispose();
  }, 15_000);
});
