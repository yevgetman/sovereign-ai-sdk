// Contract #2 — the thin, OPEN, fetch-based typed gateway client.
//
// This module is OPEN (boundary-manifest.json → openFullyDirs, `^src/protocol/`)
// and depends ONLY on the `fetch` global + the pure protocol types in this same
// dir. NO zod, NO runtime deps, NO proprietary imports — the boundary lint
// (no-open-to-proprietary in .dependency-cruiser.cjs) actively gates this file.
//
// It is the single typed source external consumers bind to instead of
// re-deriving the wire contract by hand: in Phase 8 it ships inside
// `@yevgetman/sov-protocol`, which the Go TUI + resume-as-code adopt (collapsing
// today's three hand-copies of the request/response shapes + the SSE frame
// parser). The client TRUSTS the typed contract — runtime validation stays
// SERVER-SIDE (the gateway keeps its zod schemas), so there is intentionally no
// zod here: a parsed response is cast to its protocol type, an SSE `data:`
// payload to `ServerEvent`.

import {
  type CancelTurnResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ErrorResponse,
  type HealthResponse,
  PROTOCOL_PATHS,
  type PostApprovalRequest,
  type PostApprovalResponse,
  type PostTurnRequest,
  type PostTurnResponse,
} from './endpoints.js';
import type { ServerEvent } from './events.js';

// --- internal request helpers -----------------------------------------------

/** Build the `RequestInit` for a JSON endpoint: a `Bearer` auth header (unless
 *  `token` is null — the health probe), and a JSON body + `Content-Type` only
 *  when a body is supplied (the bodyless POSTs — create / cancel — send neither,
 *  matching the handlers that never parse one). */
function buildInit(token: string | null, method: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    return { method, headers, body: JSON.stringify(body) };
  }
  return { method, headers };
}

/** Read a JSON response as `T`, trusting the typed contract (no zod). A non-2xx
 *  response throws an Error that surfaces the gateway's `{ error }` envelope when
 *  present, so a consumer gets a clear failure instead of a mis-typed body. */
async function readJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status})${await errorDetail(res)}`);
  }
  return (await res.json()) as T;
}

/** Best-effort extraction of the `{ error }` envelope from a failed response.
 *  Returns `''` when the body is absent / not the JSON error shape. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ErrorResponse;
    return typeof body.error === 'string' ? `: ${body.error}` : '';
  } catch {
    return '';
  }
}

/** Substitute the `:id` placeholder in a `PROTOCOL_PATHS` template. */
function fillSession(path: string, sessionId: string): string {
  return path.replace(':id', encodeURIComponent(sessionId));
}

/** Substitute both `:id` and `:requestId` placeholders. */
function fillApproval(path: string, sessionId: string, requestId: string): string {
  return path
    .replace(':id', encodeURIComponent(sessionId))
    .replace(':requestId', encodeURIComponent(requestId));
}

// --- the 6 Contract #2 endpoint functions -----------------------------------

/** POST /sessions — mint a fresh session. The handler never reads a body, so
 *  `body` is optional (and an empty object either way). 201 → `{ sessionId,
 *  createdAt }`. */
export async function createSession(
  baseUrl: string,
  token: string,
  body?: CreateSessionRequest,
): Promise<CreateSessionResponse> {
  const url = `${baseUrl}${PROTOCOL_PATHS.sessions}`;
  const res = await fetch(url, buildInit(token, 'POST', body));
  return readJson<CreateSessionResponse>(res, 'createSession');
}

/** POST /sessions/:id/turns — submit a user turn (fire-and-forget on the
 *  server; events flow over `streamEvents`). 202 → `{ accepted: true }`. */
export async function postTurn(
  baseUrl: string,
  token: string,
  sessionId: string,
  body: PostTurnRequest,
): Promise<PostTurnResponse> {
  const url = `${baseUrl}${fillSession(PROTOCOL_PATHS.turns, sessionId)}`;
  const res = await fetch(url, buildInit(token, 'POST', body));
  return readJson<PostTurnResponse>(res, 'postTurn');
}

/** POST /sessions/:id/approvals/:requestId — resolve a pending permission
 *  request. 200 → `{ ok: true }`. */
export async function postApproval(
  baseUrl: string,
  token: string,
  sessionId: string,
  requestId: string,
  body: PostApprovalRequest,
): Promise<PostApprovalResponse> {
  const url = `${baseUrl}${fillApproval(PROTOCOL_PATHS.approval, sessionId, requestId)}`;
  const res = await fetch(url, buildInit(token, 'POST', body));
  return readJson<PostApprovalResponse>(res, 'postApproval');
}

/** POST /sessions/:id/cancel — abort the active turn (idempotent no-op when
 *  none is running). 200 → `{ cancelled }`. No request body. */
export async function cancel(
  baseUrl: string,
  token: string,
  sessionId: string,
): Promise<CancelTurnResponse> {
  const url = `${baseUrl}${fillSession(PROTOCOL_PATHS.cancel, sessionId)}`;
  const res = await fetch(url, buildInit(token, 'POST'));
  return readJson<CancelTurnResponse>(res, 'cancel');
}

/** GET /health — liveness probe. No auth, no session. 200 → `{ ok, version }`. */
export async function health(baseUrl: string): Promise<HealthResponse> {
  const url = `${baseUrl}${PROTOCOL_PATHS.health}`;
  const res = await fetch(url, buildInit(null, 'GET'));
  return readJson<HealthResponse>(res, 'health');
}

/** GET /sessions/:id/events — the SSE event stream. Yields one typed
 *  `ServerEvent` per `data:` frame. `opts.lastEventId` is sent as the standard
 *  `Last-Event-ID` reconnect header (the gateway replays only events with a
 *  greater `seq`); `opts.signal` aborts the underlying fetch.
 *
 *  The frame parser is the open, canonical version of what resume-as-code
 *  hand-rolled and what `sov drive` runs inline: accumulate bytes, split on the
 *  `\n\n` block separator, and lift the (last) `data:` line out of each complete
 *  block. Comment frames (`: connected`) and any block without a `data:` line
 *  are skipped. The `id:`/`event:` lines are part of the frame the gateway
 *  emits; the payload (`seq` included) lives in `data:`, so that JSON drives the
 *  yielded event. */
export async function* streamEvents(
  baseUrl: string,
  token: string,
  sessionId: string,
  opts: { lastEventId?: string; signal?: AbortSignal } = {},
): AsyncGenerator<ServerEvent> {
  const url = `${baseUrl}${fillSession(PROTOCOL_PATHS.events, sessionId)}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.lastEventId !== undefined) {
    headers['Last-Event-ID'] = opts.lastEventId;
  }
  const init: RequestInit = { method: 'GET', headers };
  if (opts.signal !== undefined) {
    init.signal = opts.signal;
  }
  const res = await fetch(url, init);
  if (!res.ok || res.body === null) {
    throw new Error(`streamEvents failed (${res.status})${await errorDetail(res)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let blockEnd = buffer.indexOf('\n\n');
      while (blockEnd !== -1) {
        const block = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd + 2);
        const ev = parseEventFrame(block);
        if (ev !== null) {
          yield ev;
        }
        blockEnd = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if a read is in flight; the stream is closing anyway.
    }
  }
}

/** Lift the `data:` payload out of one SSE frame and parse it as a
 *  `ServerEvent`. Returns null for a comment frame, a frame with no `data:`
 *  line, or an unparseable payload (the loop is defensive — the gateway emits
 *  single-line, well-formed JSON `data:` frames). */
function parseEventFrame(block: string): ServerEvent | null {
  let data: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      // SSE strips a single leading space after the field colon.
      data = line.slice('data:'.length).replace(/^ /, '');
    }
  }
  if (data === null) {
    return null;
  }
  try {
    return JSON.parse(data) as ServerEvent;
  } catch {
    return null;
  }
}
