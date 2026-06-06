// Phase B T1 — multi-subscriber event bus + bounded replay ring + markTurnStart.
//
// These tests pin the new contract: fan-out to many subscribers, a bounded
// replay ring, Last-Event-ID reconnect replay, fresh-subscriber current-turn
// replay (the single-client "POST /turns then GET /events" path), and an
// idempotent close(). seq stays caller-owned (stamped via nextSeq before
// publish, exactly as the real route does).

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_RING,
  ServerEventBus,
  __test_resetAllBuses,
  getOrCreateBus,
  setDefaultRingSize,
} from '../../src/server/eventBus.js';
import type { ServerEvent } from '../../src/server/schema.js';

const sessionId = 's_multi';

/** Build a text_delta event, stamping seq the way the real caller does. */
function emit(bus: ServerEventBus, text: string): ServerEvent {
  return {
    type: 'text_delta',
    seq: bus.nextSeq(),
    sessionId,
    block: 0,
    text,
  };
}

describe('ServerEventBus — multi-subscriber + replay ring (T1)', () => {
  test('fan-out: two subscribers both receive a published event', () => {
    const bus = new ServerEventBus();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    bus.subscribe((ev) => a.push(ev));
    bus.subscribe((ev) => b.push(ev));

    bus.publish(emit(bus, 'one'));

    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]?.type).toBe('text_delta');
    expect(b[0]?.type).toBe('text_delta');
  });

  test('fan-out: unsubscribing one keeps the other receiving', () => {
    const bus = new ServerEventBus();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const unsubA = bus.subscribe((ev) => a.push(ev));
    bus.subscribe((ev) => b.push(ev));

    bus.publish(emit(bus, 'one'));
    unsubA();
    bus.publish(emit(bus, 'two'));

    // a saw only the first; b saw both.
    expect(a.length).toBe(1);
    expect(b.length).toBe(2);
  });

  test('ring retain/evict: ring holds only the last N events', () => {
    const bus = new ServerEventBus(3);
    // No subscriber yet; everything lands in the ring.
    for (let i = 1; i <= 5; i++) {
      bus.publish(emit(bus, `e${i}`));
    }

    // A fresh subscriber with lastEventId=0 replays everything still retained.
    const replayed: ServerEvent[] = [];
    bus.subscribe((ev) => replayed.push(ev), { lastEventId: 0 });

    // Ring capped at 3 → only the last three (seq 3,4,5) survive.
    expect(replayed.length).toBe(3);
    expect(replayed.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  test('reconnect replay: lastEventId replays seq > N in order, then live events flow', () => {
    const bus = new ServerEventBus();
    for (let i = 1; i <= 5; i++) {
      bus.publish(emit(bus, `e${i}`));
    }

    const got: ServerEvent[] = [];
    // Reconnect having last seen seq 3 → expect 4,5 replayed.
    bus.subscribe((ev) => got.push(ev), { lastEventId: 3 });
    expect(got.map((e) => e.seq)).toEqual([4, 5]);

    // Subsequent live events continue to flow to the same subscriber.
    bus.publish(emit(bus, 'e6'));
    expect(got.map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  test('reconnect replay: lastEventId below the retained window replays from oldest retained (best-effort, no crash)', () => {
    const bus = new ServerEventBus(3);
    for (let i = 1; i <= 5; i++) {
      bus.publish(emit(bus, `e${i}`));
    }
    // Retained window is seq 3,4,5. Client claims it last saw seq 1 — below the
    // window. Best-effort: replay everything still retained, no crash.
    const got: ServerEvent[] = [];
    expect(() => {
      bus.subscribe((ev) => got.push(ev), { lastEventId: 1 });
    }).not.toThrow();
    expect(got.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  test('fresh = current-turn: fresh subscribe replays only events since markTurnStart', () => {
    const bus = new ServerEventBus();
    // Turn 1 events.
    bus.publish(emit(bus, 't1-a'));
    bus.publish(emit(bus, 't1-b'));

    // Boundary: start turn 2.
    bus.markTurnStart();

    // Turn 2 events.
    bus.publish(emit(bus, 't2-a'));
    bus.publish(emit(bus, 't2-b'));

    // A fresh subscriber (no opts) should see ONLY the current turn's events.
    const got: ServerEvent[] = [];
    bus.subscribe((ev) => got.push(ev));

    expect(got.map((e) => (e.type === 'text_delta' ? e.text : ''))).toEqual(['t2-a', 't2-b']);
    // The pre-markTurnStart events (seq 1,2) are not replayed.
    expect(got.map((e) => e.seq)).toEqual([3, 4]);
  });

  test('fresh, no turn yet: subscribe before any markTurnStart + before any publish gets live events', () => {
    const bus = new ServerEventBus();
    const got: ServerEvent[] = [];
    expect(() => {
      bus.subscribe((ev) => got.push(ev));
    }).not.toThrow();
    // Nothing replayed (ring empty).
    expect(got.length).toBe(0);

    // Live events flow.
    bus.publish(emit(bus, 'a'));
    bus.publish(emit(bus, 'b'));
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
  });

  test('fresh, no turn yet: replays current-turn from seq 0 (single-client POST-then-GET path)', () => {
    // Mirrors the live single-client flow: turn publishes events, THEN the SSE
    // route subscribes fresh with no opts and no markTurnStart wired (that's
    // a later task). All buffered events must still be delivered.
    const bus = new ServerEventBus();
    bus.publish(emit(bus, 'hello'));
    bus.publish(emit(bus, 'world'));

    const got: ServerEvent[] = [];
    bus.subscribe((ev) => got.push(ev));
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
  });

  test('close(): idempotent + publish is a no-op after close + abort signal fired', () => {
    const bus = new ServerEventBus();
    const got: ServerEvent[] = [];
    bus.subscribe((ev) => got.push(ev));

    expect(bus.isClosed()).toBe(false);
    expect(bus.abortSignal.aborted).toBe(false);

    bus.close();
    expect(bus.isClosed()).toBe(true);
    expect(bus.abortSignal.aborted).toBe(true);

    // Idempotent — second close does not throw.
    expect(() => bus.close()).not.toThrow();

    // publish after close is a no-op (no delivery, no throw).
    expect(() => bus.publish(emit(bus, 'after-close'))).not.toThrow();
    expect(got.length).toBe(0);
  });

  test('close(): clears subscribers so a post-close publish never reaches them', () => {
    const bus = new ServerEventBus();
    const got: ServerEvent[] = [];
    bus.subscribe((ev) => got.push(ev));
    bus.publish(emit(bus, 'live'));
    expect(got.length).toBe(1);

    bus.close();
    bus.publish(emit(bus, 'dropped'));
    expect(got.length).toBe(1);
  });

  test('currentTurnAbort API preserved across the multi-subscriber rewrite', () => {
    const bus = new ServerEventBus();
    // No turn registered → cancel reports false.
    expect(bus.cancelCurrentTurn()).toBe(false);

    const turnAbort = new AbortController();
    bus.setCurrentTurnAbort(turnAbort);
    expect(bus.cancelCurrentTurn()).toBe(true);
    expect(turnAbort.signal.aborted).toBe(true);

    // After clear, cancel reports false again.
    bus.clearCurrentTurnAbort();
    expect(bus.cancelCurrentTurn()).toBe(false);
  });
});

// Phase B T2 — configurable replay-ring size via the module-level default.
// buildRuntime calls setDefaultRingSize(config.gateway?.eventBufferSize ??
// DEFAULT_MAX_RING) at boot; getOrCreateBus then mints first-create buses
// with that size without threading it through every caller.
describe('setDefaultRingSize + getOrCreateBus (T2)', () => {
  /** Build a text_delta event on an arbitrary session id, stamping seq. */
  function emitOn(bus: ServerEventBus, sid: string, text: string): ServerEvent {
    return { type: 'text_delta', seq: bus.nextSeq(), sessionId: sid, block: 0, text };
  }

  test('a freshly created bus retains only the last N events after setDefaultRingSize(N)', () => {
    __test_resetAllBuses();
    setDefaultRingSize(3);
    try {
      const sid = 's_t2_ring';
      const bus = getOrCreateBus(sid);
      for (let i = 1; i <= 5; i++) {
        bus.publish(emitOn(bus, sid, `e${i}`));
      }

      // Fresh subscriber from seq 0 replays everything still retained.
      const replayed: ServerEvent[] = [];
      bus.subscribe((ev) => replayed.push(ev), { lastEventId: 0 });

      // Ring capped at 3 → only seq 3,4,5 survive.
      expect(replayed.map((e) => e.seq)).toEqual([3, 4, 5]);
    } finally {
      // Restore the module default so later tests are unaffected.
      setDefaultRingSize(DEFAULT_MAX_RING);
      __test_resetAllBuses();
    }
  });

  test('invalid sizes are ignored (clamped to default), no crash', () => {
    __test_resetAllBuses();
    // Non-positive / non-finite values must not crash and must fall back to
    // the default so the ring always retains at least the default window.
    expect(() => setDefaultRingSize(0)).not.toThrow();
    expect(() => setDefaultRingSize(-5)).not.toThrow();
    expect(() => setDefaultRingSize(1.5)).not.toThrow();
    expect(() => setDefaultRingSize(Number.NaN)).not.toThrow();

    const sid = 's_t2_invalid';
    const bus = getOrCreateBus(sid);
    // With the default window restored, far more than a tiny ring is retained.
    for (let i = 1; i <= 10; i++) {
      bus.publish(emitOn(bus, sid, `e${i}`));
    }
    const replayed: ServerEvent[] = [];
    bus.subscribe((ev) => replayed.push(ev), { lastEventId: 0 });
    expect(replayed.length).toBe(10);

    __test_resetAllBuses();
  });
});
