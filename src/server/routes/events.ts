// GET /sessions/:id/events — SSE stream of server events for a session.
//
// Phase 16.1 M3: consumes the per-session event bus populated by the turn
// handler. Events buffered before the subscriber attaches are drained
// immediately so a "POST /turns, then GET /events" sequence is well-defined
// without a sleep. By default the stream ends when turn_complete or
// turn_error arrives, or when the client disconnects (c.req.raw.signal
// aborts the parked Promise).
//
// Phase B T3 — reconnect + follow + per-session bus lifecycle:
//   - Last-Event-ID reconnect. A client that dropped mid-turn reconnects
//     with the `Last-Event-ID` header (the SSE standard) — or the
//     `?lastEventId=<n>` query equivalent — and the bus replays only events
//     with seq > that value (no duplicates), then goes live. A non-negative
//     integer enables replay; anything else falls back to fresh-subscriber
//     current-turn replay.
//   - `?follow=true` persistent stream. A follow stream does NOT close on
//     turn_complete / turn_error — it keeps streaming subsequent turns on the
//     SAME connection until the client disconnects or the bus closes. Without
//     `?follow` the default per-turn contract is unchanged (close on the
//     turn terminal).
//   - Bus lifecycle moved OFF this route. The bus is NO LONGER disposed in
//     the `finally` — disposal is now per-session (runtime.disposeSession →
//     disposeBus) and at full shutdown (runtime.dispose). This lets the
//     replay ring survive a reconnect window and across turns. The `finally`
//     here only unsubscribes + removes the abort listener.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getOrCreateBus } from '../eventBus.js';
import type { ServerEvent } from '../schema.js';
import { isValidSessionId } from '../sessionId.js';

/** Parse the reconnect cursor from the `Last-Event-ID` header, falling back to
 *  the `?lastEventId=<n>` query param. Returns a non-negative integer seq when
 *  valid, otherwise undefined (the bus then treats the subscribe as fresh —
 *  current-turn replay). A negative or non-numeric value is ignored rather
 *  than crashing the stream. */
function parseLastEventId(
  headerValue: string | undefined,
  queryValue: string | undefined,
): number | undefined {
  const raw = headerValue ?? queryValue;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export const eventsRoute = new Hono();

eventsRoute.get('/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'invalid session id' }, 400);
  }
  const bus = getOrCreateBus(sessionId);
  const requestSignal = c.req.raw.signal;
  // Reconnect cursor: `Last-Event-ID` header (SSE standard) wins, else the
  // `?lastEventId=<n>` query equivalent. A valid non-negative int enables
  // seq > N replay; undefined falls through to fresh current-turn replay.
  const lastEventId = parseLastEventId(c.req.header('Last-Event-ID'), c.req.query('lastEventId'));
  // `?follow=true` keeps the stream open across turn boundaries.
  const follow = c.req.query('follow') === 'true';
  return streamSSE(c, async (stream) => {
    // Flush the response headers immediately with an SSE comment line. Without
    // an initial write, Bun does not send the HTTP response headers until the
    // first event is written — so a browser `fetch()` opening a `?follow`
    // stream on an idle session (no queued events, e.g. right after a
    // reconnect to a fresh session) stays pending on the headers forever. That
    // left the reference web UI wedged in a permanent "Reconnecting…" state
    // because its stream-reader promise never resolved. The leading `:` makes
    // this a comment frame the SSE spec (and our client parser) ignore.
    await stream.write(': connected\n\n');
    let stopped = false;
    const queue: ServerEvent[] = [];
    let resolver: (() => void) | null = null;
    // Wake the loop if it is parked on the empty-queue Promise. Shared by the
    // live-event push, the client-disconnect abort handler, and (Fix 1) the
    // bus-abort handler so they all release a parked loop the same way.
    const wake = (): void => {
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        r();
      }
    };
    const onEvent = (ev: ServerEvent): void => {
      queue.push(ev);
      wake();
    };
    // Pass the reconnect cursor through to the bus so it replays the right
    // ring slice (seq > lastEventId) synchronously on attach, with no
    // duplicates of what the client already received. Omitting the option
    // (the common fresh-subscriber path) yields current-turn replay —
    // byte-identical to the pre-T3 default.
    const unsubscribe =
      lastEventId !== undefined ? bus.subscribe(onEvent, { lastEventId }) : bus.subscribe(onEvent);
    // Fix 2 — capture the synchronous replay count. `subscribe()` calls
    // `onEvent` (which pushes onto `queue`) for each replayed ring event
    // BEFORE returning, so right here `queue.length` is exactly how many
    // events were replayed on attach. A NON-follow stream that replayed
    // NOTHING and lands with no turn in progress has nothing to wait for —
    // the turn already completed and its terminal event is past the cursor.
    // Without this it would park forever on the empty-queue Promise (the
    // bus closes only at session/shutdown teardown). End immediately instead.
    // This does NOT affect `?follow` (it never auto-ends), and it does NOT
    // affect the normal "POST /turns then GET /events" path (a turn IS active
    // at subscribe time) nor a reconnect mid-turn (replay is non-empty there).
    const replayedCount = queue.length;
    if (!follow && replayedCount === 0 && !bus.isTurnActive()) {
      stopped = true;
    }
    // Fix 1 — the bus being disposed (disposeSession / dispose → bus.close())
    // is a SECOND stop source, mirroring requestSignal below. Without it an
    // open ?follow stream (which never auto-ends on a turn terminal) stays
    // parked on the empty-queue Promise forever after the bus closes — a
    // dangling connection that outlives its session. If the bus is already
    // closed by the time we attach, don't park at all; otherwise wake + stop
    // the loop when its abortSignal fires. (close() also clears subscribers,
    // so onEvent won't fire after this — the loop must be woken explicitly.)
    if (bus.abortSignal.aborted) {
      stopped = true;
    }
    const onBusAbort = (): void => {
      stopped = true;
      wake();
    };
    bus.abortSignal.addEventListener('abort', onBusAbort);
    // Without this listener the loop can park forever on the empty-queue
    // Promise: a client disconnect with no pending events leaves nothing
    // to invoke the resolver, so `unsubscribe()` never runs and the
    // subscriber leaks (the bus itself is now reclaimed per-session, not
    // here).
    const abortHandler = (): void => {
      stopped = true;
      wake();
    };
    requestSignal.addEventListener('abort', abortHandler);
    try {
      while (!stopped) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolver = r;
          });
        }
        const ev = queue.shift();
        if (ev === undefined) continue;
        await stream.writeSSE({
          event: ev.type,
          id: String(ev.seq),
          data: JSON.stringify(ev),
        });
        // Default per-turn contract: end the stream on the turn terminal.
        // A `?follow` stream skips this so it keeps streaming subsequent
        // turns on the same connection until the client disconnects (the
        // abort handler above) or the bus closes (server.stop / dispose).
        if (!follow && (ev.type === 'turn_complete' || ev.type === 'turn_error')) {
          stopped = true;
        }
      }
    } finally {
      requestSignal.removeEventListener('abort', abortHandler);
      bus.abortSignal.removeEventListener('abort', onBusAbort);
      unsubscribe();
      // Phase B T3 — the bus is intentionally NOT disposed here anymore.
      // Disposal moved to per-session teardown (runtime.disposeSession →
      // disposeBus) and full shutdown (runtime.dispose → abortAllBuses +
      // the disposeSession walk). Keeping the bus alive past this stream's
      // close is what lets a reconnect (within the window) replay the
      // retained ring and what lets the ring survive across turns.
    }
  });
});
