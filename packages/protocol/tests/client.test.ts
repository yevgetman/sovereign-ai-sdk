// Contract #2 thin-client tests.
//
// The client (src/protocol/client.ts) is OPEN + fetch-only, so these tests stub
// the `fetch` global: each test installs a handler that records the (url, init)
// it was called with and returns a scripted Response, then asserts (a) the
// request shape the client built — method / path / auth header / JSON body — and
// (b) that the typed response / SSE payload parsed back out. `streamEvents` is
// driven by a scripted SSE `ReadableStream` (including a frame deliberately split
// across two chunks) to exercise the `\n\n`-block frame parser + buffering.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cancel,
  createSession,
  health,
  postApproval,
  postTurn,
  streamEvents,
} from '@yevgetman/sov-protocol';
import type { ServerEvent } from '@yevgetman/sov-protocol';

const BASE = 'http://gateway.test';
const TOKEN = 'tok-abc';
// Valid-shaped ids so encodeURIComponent is an identity (no escaping noise).
const SID = 'sess-00000000-0000-4000-8000-000000000000';
const RID = 'req-11111111-1111-4111-8111-111111111111';

type FetchCall = { url: string; init: RequestInit | undefined };

let calls: FetchCall[];
let realFetch: typeof fetch;

function toUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Replace the global fetch with a recording stub that defers to `handler`. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = toUrl(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The single fetch call each test records (throws if none — keeps the tests
 *  honest without a non-null assertion). */
function onlyCall(): FetchCall {
  const call = calls.at(-1);
  if (call === undefined) {
    throw new Error('no fetch call was recorded');
  }
  return call;
}

function header(call: FetchCall, name: string): string | undefined {
  const h = call.init?.headers as Record<string, string> | undefined;
  return h?.[name];
}

function bodyJson(call: FetchCall): unknown {
  return JSON.parse(call.init?.body as string);
}

/** A one-shot SSE body from pre-rendered string chunks. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Render one event the way the gateway's SSE route does: event / id / data. */
function frame(ev: ServerEvent): string {
  return `event: ${ev.type}\nid: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('protocol client (Contract #2)', () => {
  test('createSession POSTs /sessions with bearer auth and parses the 201 body', async () => {
    stubFetch(() => jsonResponse({ sessionId: SID, createdAt: '2026-06-29T00:00:00.000Z' }, 201));

    const res = await createSession(BASE, TOKEN);

    expect(calls).toHaveLength(1);
    const call = onlyCall();
    expect(call.url).toBe(`${BASE}/sessions`);
    expect(call.init?.method).toBe('POST');
    expect(header(call, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.init?.body).toBeUndefined();
    expect(res).toEqual({ sessionId: SID, createdAt: '2026-06-29T00:00:00.000Z' });
  });

  test('postTurn POSTs the JSON turn body to /sessions/:id/turns', async () => {
    stubFetch(() => jsonResponse({ accepted: true }, 202));

    const res = await postTurn(BASE, TOKEN, SID, { text: 'hello', kind: 'skill' });

    const call = onlyCall();
    expect(call.url).toBe(`${BASE}/sessions/${SID}/turns`);
    expect(call.init?.method).toBe('POST');
    expect(header(call, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(header(call, 'Content-Type')).toBe('application/json');
    expect(bodyJson(call)).toEqual({ text: 'hello', kind: 'skill' });
    expect(res.accepted).toBe(true);
  });

  test('postApproval POSTs to /sessions/:id/approvals/:requestId', async () => {
    stubFetch(() => jsonResponse({ ok: true }));

    const res = await postApproval(BASE, TOKEN, SID, RID, { approved: true, always: false });

    const call = onlyCall();
    expect(call.url).toBe(`${BASE}/sessions/${SID}/approvals/${RID}`);
    expect(call.init?.method).toBe('POST');
    expect(bodyJson(call)).toEqual({ approved: true, always: false });
    expect(res.ok).toBe(true);
  });

  test('cancel POSTs to /sessions/:id/cancel with no body', async () => {
    stubFetch(() => jsonResponse({ cancelled: true }));

    const res = await cancel(BASE, TOKEN, SID);

    const call = onlyCall();
    expect(call.url).toBe(`${BASE}/sessions/${SID}/cancel`);
    expect(call.init?.method).toBe('POST');
    expect(header(call, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.init?.body).toBeUndefined();
    expect(res.cancelled).toBe(true);
  });

  test('health GETs /health without an Authorization header', async () => {
    stubFetch(() => jsonResponse({ ok: true, version: '1.2.3' }));

    const res = await health(BASE);

    const call = onlyCall();
    expect(call.url).toBe(`${BASE}/health`);
    expect(call.init?.method).toBe('GET');
    expect(header(call, 'Authorization')).toBeUndefined();
    expect(res).toEqual({ ok: true, version: '1.2.3' });
  });

  test('a non-2xx JSON response throws, surfacing the gateway error envelope', async () => {
    stubFetch(() => jsonResponse({ error: 'text is required' }, 400));

    await expect(postTurn(BASE, TOKEN, SID, { text: '' })).rejects.toThrow('text is required');
  });

  test('streamEvents yields typed ServerEvents from a scripted SSE body', async () => {
    const e1: ServerEvent = { type: 'text_delta', seq: 1, sessionId: SID, block: 0, text: 'hi' };
    const e2: ServerEvent = {
      type: 'turn_complete',
      seq: 2,
      sessionId: SID,
      finishReason: 'end_turn',
    };
    const body = sseStream([': connected\n\n', frame(e1), frame(e2)]);
    stubFetch(
      () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const out: ServerEvent[] = [];
    for await (const ev of streamEvents(BASE, TOKEN, SID)) {
      out.push(ev);
    }

    expect(out).toEqual([e1, e2]);
    const call = onlyCall();
    expect(call.url).toBe(`${BASE}/sessions/${SID}/events`);
    expect(call.init?.method).toBe('GET');
    expect(header(call, 'Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  test('streamEvents sends Last-Event-ID + signal and reassembles split frames', async () => {
    const ev: ServerEvent = { type: 'status_update', seq: 5, sessionId: SID, streaming: true };
    const full = frame(ev);
    const mid = Math.floor(full.length / 2);
    const body = sseStream([full.slice(0, mid), full.slice(mid)]);
    stubFetch(() => new Response(body, { status: 200 }));
    const ctrl = new AbortController();

    const out: ServerEvent[] = [];
    for await (const e of streamEvents(BASE, TOKEN, SID, {
      lastEventId: '4',
      signal: ctrl.signal,
    })) {
      out.push(e);
    }

    expect(out).toEqual([ev]);
    const call = onlyCall();
    expect(header(call, 'Last-Event-ID')).toBe('4');
    expect(call.init?.signal).toBe(ctrl.signal);
  });

  test('streamEvents throws when the SSE GET is not ok', async () => {
    stubFetch(() => jsonResponse({ error: 'not found' }, 404));

    const gen = streamEvents(BASE, TOKEN, SID);
    await expect(gen.next()).rejects.toThrow('404');
  });
});
