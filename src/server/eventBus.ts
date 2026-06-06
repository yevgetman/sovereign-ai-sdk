// Phase 16.1 M3.4 — per-session SSE event bus.
// Phase B T1 — multi-subscriber + bounded replay ring + markTurnStart.
//
// The turn handler publishes onto the bus; the SSE route subscribes and
// pipes events to the wire. The bus is now MULTI-subscriber (fan-out to a
// Set) and retains a bounded ring of recent events so a later transport
// task can serve `Last-Event-ID` reconnect replay and fresh-subscriber
// current-turn replay. The original single-client "POST /turns, then
// GET /events" path is preserved: a fresh subscriber (no opts) synchronously
// replays the current turn's buffered events before going live, so there is
// still no race-prone sleep.
//
// Lifecycle: a bus exists for the duration of one or more SSE subscriber
// connections. `getOrCreateBus(sessionId)` lazily allocates on first publish
// or first subscribe; `disposeBus(sessionId)` is invoked by the events route's
// `finally` so the per-session entry leaves the map after the stream closes
// (turn_complete / turn_error / client disconnect).
//
// Sequence numbers are per-bus-lifetime (per-session, accumulating across
// turns). They are CALLER-OWNED: the publisher stamps `ev.seq` via
// `bus.nextSeq()` BEFORE calling `publish()`. `publish()` never assigns seq.
// The ring and all replay logic key on `ev.seq`. Code that assumes seq starts
// at 1 per turn will break — that's intentional; rely on the discriminator
// (turn_complete event) not the seq value to detect turn boundaries.
//
// markTurnStart(): records the seq the turn's first event will carry (called
// before that event is stamped, so currentTurnStartSeq = seq + 1) so a fresh
// subscriber replays only the in-progress turn (seq >= currentTurnStartSeq).
// currentTurnStartSeq defaults to 0, so before any turn is marked a fresh
// subscriber replays everything still retained — exactly the pre-T1
// drain-the-buffer behavior.
//
// Abort signal: every bus owns an AbortController fired on `close()`. The
// turns route plumbs the signal into `query()` so a client disconnect or
// `server.stop()` cooperatively cancels the in-flight provider stream and
// tool calls rather than letting them keep running into a closed bus.

import type { ServerEvent } from './schema.js';

/** Default bound on the per-bus replay ring. */
export const DEFAULT_MAX_RING = 512;

export class ServerEventBus {
  private subscribers = new Set<(ev: ServerEvent) => void>();
  /**
   * Bounded ring of recently-published events, retained for reconnect /
   * fresh-subscriber replay. Oldest events are shifted off once the ring
   * exceeds `maxRing`. Events are kept in publish (and therefore seq) order.
   */
  private ring: ServerEvent[] = [];
  private readonly maxRing: number;
  /**
   * seq recorded at the most recent `markTurnStart()`. A fresh subscriber
   * (no `lastEventId`) replays events with `seq >= currentTurnStartSeq`.
   * Defaults to 0 so, before any turn boundary is marked, a fresh subscriber
   * replays everything still retained (pre-T1 behavior).
   */
  private currentTurnStartSeq = 0;
  /**
   * Fix 2 — whether a turn is currently in progress on this bus. Set true by
   * `markTurnStart()`; reset to false when `publish()` sees a terminal event
   * (`turn_complete` / `turn_error`). The events route reads this via
   * `isTurnActive()` so a NON-follow reconnect that replays nothing AND lands
   * with no active turn can end immediately instead of parking forever waiting
   * for a terminal that already fired. Defaults to false (no turn before the
   * first `markTurnStart`).
   */
  private turnActive = false;
  private seq = 0;
  private closed = false;
  private readonly abortController = new AbortController();
  // ux-fixes round 4 — per-turn abort. The bus-level abortController
  // fires on close() (SSE disconnect / server.stop) and tears down
  // EVERYTHING. The currentTurnAbort fires only on user cancel and
  // stops the active turn without disposing the bus, so subsequent
  // turns on the same session keep working. turns.ts registers it at
  // turn start and clears it in the finally block.
  private currentTurnAbort: AbortController | null = null;

  /**
   * @param maxRing Bound on the replay ring. Defaults to {@link DEFAULT_MAX_RING}.
   *   A non-positive value is coerced to the default so the ring always retains
   *   at least the default window.
   */
  constructor(maxRing: number = DEFAULT_MAX_RING) {
    this.maxRing = maxRing > 0 ? maxRing : DEFAULT_MAX_RING;
  }

  /**
   * Fires on `close()`. Wire this into long-running work that should
   * cooperatively cancel when the bus is disposed — e.g. the provider
   * stream + tool loop driven by `query()`.
   */
  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Register the AbortController of the currently-running turn so the
   * POST /sessions/:id/cancel route can fire it. Called at turn start
   * by runTurnInBackground; cleared by the matching `finally` block.
   * ux-fixes round 4.
   */
  setCurrentTurnAbort(c: AbortController): void {
    this.currentTurnAbort = c;
  }

  /** Clear the current turn's abort controller. Idempotent. */
  clearCurrentTurnAbort(): void {
    this.currentTurnAbort = null;
  }

  /**
   * Abort the current turn's controller if one is registered. Returns
   * true when a turn was actually cancelled; false when no turn was
   * active (the cancel endpoint then 200s with `{cancelled: false}`).
   * ux-fixes round 4.
   */
  cancelCurrentTurn(): boolean {
    if (this.currentTurnAbort === null) return false;
    this.currentTurnAbort.abort();
    return true;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  /**
   * Record the seq the turn's first event will carry as the turn boundary.
   * `markTurnStart` runs BEFORE the turn stamps its first event, so the next
   * `nextSeq()` returns `this.seq + 1` — that is the first event of this turn.
   * A subsequent fresh subscriber (no `lastEventId`) replays only events with
   * `seq >= currentTurnStartSeq`, i.e. exactly the in-progress turn (events
   * from prior turns are excluded). Called by the turns route at turn start.
   * Idempotent in effect — just overwrites the mark.
   */
  markTurnStart(): void {
    this.currentTurnStartSeq = this.seq + 1;
    // Fix 2 — a turn is now in progress. Cleared by `publish()` on the
    // matching terminal event.
    this.turnActive = true;
  }

  /**
   * Fix 2 — whether a turn is currently in progress (between `markTurnStart()`
   * and its terminal `turn_complete` / `turn_error`). The events route uses
   * this to decide whether a NON-follow stream that replayed nothing should
   * end immediately (no active turn → nothing to wait for) rather than park.
   */
  isTurnActive(): boolean {
    return this.turnActive;
  }

  /**
   * Publish an event. seq is CALLER-OWNED (stamped via `nextSeq()` before this
   * call) — `publish` never assigns it. Retains the event in the bounded ring
   * (evicting the oldest past `maxRing`) and fans out to every subscriber.
   * No-op once closed.
   */
  publish(event: ServerEvent): void {
    if (this.closed) return;
    this.ring.push(event);
    if (this.ring.length > this.maxRing) {
      this.ring.shift();
    }
    // Fix 2 — a terminal event ends the in-progress turn. After this, a
    // non-follow reconnect that replays nothing knows the turn is done and
    // can end immediately instead of parking.
    if (event.type === 'turn_complete' || event.type === 'turn_error') {
      this.turnActive = false;
    }
    // Fix 3 — isolate throwing subscribers. A subscriber callback (an SSE
    // route's onEvent, a future cross-process forwarder) must never let its
    // own throw skip later subscribers or propagate back into the publisher
    // (the turn loop / scheduler that called publish()). Catch + log to
    // stderr and continue the fan-out.
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[eventBus] subscriber threw: ${msg}\n`);
      }
    }
  }

  /**
   * Subscribe to events. Synchronously replays a slice of the retained ring
   * (in seq order) BEFORE registering the subscriber — so no event published
   * during attach is missed or duplicated — then delivers live events.
   *
   * Replay slice:
   * - `opts.lastEventId` is a number → ring events with `seq > lastEventId`
   *   (reconnect resume). A value below the retained window is best-effort:
   *   it replays from the oldest retained event, no crash.
   * - otherwise (fresh) → ring events with `seq >= currentTurnStartSeq`
   *   (the in-progress turn; everything still retained before any turn mark).
   *
   * @returns an unsubscribe function (idempotent — safe to call repeatedly).
   */
  subscribe(fn: (ev: ServerEvent) => void, opts?: { lastEventId?: number }): () => void {
    const replay =
      typeof opts?.lastEventId === 'number'
        ? this.ring.filter((ev) => ev.seq > (opts.lastEventId as number))
        : this.ring.filter((ev) => ev.seq >= this.currentTurnStartSeq);
    for (const ev of replay) {
      fn(ev);
    }
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    this.ring = [];
    this.abortController.abort();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

const buses = new Map<string, ServerEventBus>();

/**
 * Phase B T2 — module-level default ring size for buses minted by
 * `getOrCreateBus` when the caller passes no explicit `maxRing`. Set once at
 * boot by `buildRuntime` from `gateway.eventBufferSize` so every runtime-
 * created bus inherits the configured size without threading it through each
 * call site. Starts at {@link DEFAULT_MAX_RING}.
 */
let defaultRingSize = DEFAULT_MAX_RING;

/**
 * Set the module-level default ring size used by `getOrCreateBus`. A
 * non-positive or non-integer value is ignored (clamped to
 * {@link DEFAULT_MAX_RING}) so a malformed config never shrinks the replay
 * window below the default. Only affects buses created AFTER this call.
 */
export function setDefaultRingSize(n: number): void {
  defaultRingSize = Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_RING;
}

export function getOrCreateBus(sessionId: string, maxRing?: number): ServerEventBus {
  let bus = buses.get(sessionId);
  if (bus === undefined) {
    bus = new ServerEventBus(maxRing ?? defaultRingSize);
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
 * Abort every live session bus without removing it from the map.
 *
 * Called by `runtime.dispose()` (shared by `sov gateway` / `sov serve`)
 * BEFORE `sessionDb.close()` so any in-flight background turn — whose
 * `query()` rides the bus `abortSignal` — cooperatively cancels before
 * the DB handle goes away. Without this, a turn parked in a provider
 * stream / tool loop keeps writing to a closed DB handle until
 * `process.exit`.
 *
 * `ServerEventBus.close()` is idempotent (already-closed buses no-op),
 * so this is safe to call repeatedly. The entries are intentionally left
 * in the map — the per-session events route still owns removal via
 * `disposeBus` in its `finally`; clearing the map here is a test-isolation
 * concern handled by `__test_resetAllBuses`.
 */
export function abortAllBuses(): void {
  for (const bus of buses.values()) {
    bus.close();
  }
}

/**
 * Fix 4 — close AND remove every session bus from the map.
 *
 * Called by `runtime.dispose()` at full shutdown. `dispose()` reclaims
 * per-session buses by walking `sessionContexts` → `disposeBus`, but a
 * session that only ever opened an events stream (subscribed, minting a bus
 * via `getOrCreateBus`) and never ran a turn has NO sessionContext — its bus
 * entry is closed by `abortAllBuses()` but never deleted, so it lingers in
 * the map and accumulates across repeated build/dispose cycles in one
 * process. This clears all entries unconditionally.
 *
 * Distinct from the per-session `disposeBus` (still owns single-session,
 * non-shutdown teardown) and from `abortAllBuses` (closes but intentionally
 * leaves entries for the per-session walk). Distinct from `__test_resetAllBuses`
 * — that's a soft-fenced test helper; this is the production shutdown path.
 *
 * `close()` is idempotent, so this is safe to call after `abortAllBuses()` +
 * the per-session disposal walk have already closed (and possibly removed)
 * some entries.
 */
export function clearAllBuses(): void {
  for (const bus of buses.values()) {
    bus.close();
  }
  buses.clear();
}

/**
 * Test-only: reset all buses so a fresh suite starts clean.
 *
 * The `__test_` prefix is a soft fence: production code should never reach
 * for this. If a real cleanup path is ever needed, `disposeBus(sessionId)`
 * is the supported per-session API.
 */
export function __test_busCount(): number {
  return buses.size;
}

export function __test_resetAllBuses(): void {
  for (const bus of buses.values()) {
    bus.close();
  }
  buses.clear();
}
