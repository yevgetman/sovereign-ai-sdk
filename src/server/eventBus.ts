// Phase 16.1 M3.4 — per-session SSE event bus.
//
// The turn handler publishes onto the bus; the SSE route subscribes and
// pipes events to the wire. Events queued before the subscriber attaches
// are buffered so the test pattern "POST /turns, then GET /events" works
// without race-prone sleeps. M3 keeps this single-subscriber and in-process;
// a ring buffer with Last-Event-ID replay lands in a future milestone
// (spec §5 — explicitly deferred for M3).
//
// Lifecycle: a bus exists for the duration of one SSE subscriber connection.
// `getOrCreateBus(sessionId)` lazily allocates on first publish or first
// subscribe; `disposeBus(sessionId)` is invoked by the events route's
// `finally` so the per-session entry leaves the map after the stream closes
// (turn_complete / turn_error / client disconnect). Resume across reconnects
// (M9+) will need a different lifecycle — a buffered ring + replay window.

import type { ServerEvent } from './schema.js';

export class ServerEventBus {
  private subscriber: ((ev: ServerEvent) => void) | null = null;
  private buffer: ServerEvent[] = [];
  private seq = 0;
  private closed = false;

  nextSeq(): number {
    return ++this.seq;
  }

  publish(event: ServerEvent): void {
    if (this.closed) return;
    if (this.subscriber) {
      this.subscriber(event);
    } else {
      this.buffer.push(event);
    }
  }

  subscribe(fn: (ev: ServerEvent) => void): () => void {
    this.subscriber = fn;
    while (this.buffer.length > 0) {
      const ev = this.buffer.shift();
      if (ev) fn(ev);
    }
    return () => {
      this.subscriber = null;
    };
  }

  close(): void {
    this.closed = true;
    this.subscriber = null;
    this.buffer = [];
  }

  isClosed(): boolean {
    return this.closed;
  }
}

const buses = new Map<string, ServerEventBus>();

export function getOrCreateBus(sessionId: string): ServerEventBus {
  let bus = buses.get(sessionId);
  if (bus === undefined) {
    bus = new ServerEventBus();
    buses.set(sessionId, bus);
  }
  return bus;
}

export function disposeBus(sessionId: string): void {
  const bus = buses.get(sessionId);
  if (bus !== undefined) {
    bus.close();
    buses.delete(sessionId);
  }
}

/**
 * Test-only: reset all buses so a fresh suite starts clean.
 *
 * The `__test_` prefix is a soft fence: production code should never reach
 * for this. If a real cleanup path is ever needed, `disposeBus(sessionId)`
 * is the supported per-session API.
 */
export function __test_resetAllBuses(): void {
  for (const bus of buses.values()) {
    bus.close();
  }
  buses.clear();
}
