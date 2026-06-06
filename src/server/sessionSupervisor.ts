// Phase D T2 — gateway-scoped SessionSupervisor: periodic idle-session sweep.

import { disposeBus, liveBusSessionIds, peekBus } from './eventBus.js';
import type { Runtime } from './runtime.js';

/** Default idle window before an untouched session is reclaimed (30 min). */
export const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000;
/** Default cadence of the background sweep (5 min). */
export const DEFAULT_SWEEP_INTERVAL_MS = 300_000;

export interface SupervisorOpts {
  runtime: Runtime;
  now?: () => number;
  idleSessionTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  maxConcurrentSessions?: number;
  enabled?: boolean;
}

/**
 * Owns the lifecycle of idle in-memory session state for a long-lived gateway.
 * Periodically (every `idleSweepIntervalMs`) it sweeps every live session —
 * the union of live event buses and runtime `sessionContexts` — and reclaims
 * any that are idle: NOT turn-active, with zero SSE subscribers, and untouched
 * for longer than `idleSessionTimeoutMs`. Eviction tears down the session
 * context (no `session_summary` goodbye card — no SSE consumer remains) and
 * disposes the bus.
 *
 * Purely gateway-scoped: this module is wired only into `runGateway` (T6) and
 * is never imported by the TUI / `sov drive` / `sov serve` paths.
 */
export class SessionSupervisor {
  private readonly runtime: Runtime;
  private readonly now: () => number;
  private readonly idleSessionTimeoutMs: number;
  private readonly idleSweepIntervalMs: number;
  /** The concurrency-cap policy value. Consulted by `POST /sessions` for
   *  admission control (read back via {@link getMaxConcurrentSessions}); the
   *  background `sweep` itself does not gate on it. */
  private readonly maxConcurrentSessions: number | undefined;
  private readonly enabled: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard: the promise of an in-flight `sweep`, or null. A sweep
   *  slower than `idleSweepIntervalMs` (default 5 min) could otherwise overlap
   *  the next tick; we skip the overlapping invocation (mirrors the cron
   *  runner's `inFlight`). Retained so `stop()` can await + drain it at
   *  shutdown, closing the race where a sweep's DB reads outlive
   *  `sessionDb.close()`. */
  private inFlight: Promise<{ evicted: string[]; skipped: number }> | null = null;

  constructor(opts: SupervisorOpts) {
    this.runtime = opts.runtime;
    this.now = opts.now ?? (() => Date.now());
    this.idleSessionTimeoutMs = opts.idleSessionTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleSweepIntervalMs = opts.idleSweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxConcurrentSessions = opts.maxConcurrentSessions;
    this.enabled = opts.enabled ?? true;
  }

  /** The configured concurrency cap, if any. Consulted by `POST /sessions`
   *  for admission control; the background `sweep` does not gate on it. */
  getMaxConcurrentSessions(): number | undefined {
    return this.maxConcurrentSessions;
  }

  /** Union of live event buses and active runtime session contexts. */
  liveSessionCount(): number {
    return new Set([...liveBusSessionIds(), ...this.runtime.sessionContexts.keys()]).size;
  }

  /** Live / turn-active / subscribed snapshot across all live buses. */
  stats(): { live: number; turnActive: number; subscribed: number } {
    let turnActive = 0;
    let subscribed = 0;
    for (const id of liveBusSessionIds()) {
      const bus = peekBus(id);
      if (bus === undefined) continue;
      if (bus.isTurnActive()) turnActive += 1;
      if (bus.getSubscriberCount() > 0) subscribed += 1;
    }
    return { live: this.liveSessionCount(), turnActive, subscribed };
  }

  /**
   * Sweep once. A candidate is the union of live bus ids and runtime
   * sessionContext ids. A candidate is SKIPPED when its bus is turn-active or
   * has any subscriber, or when its last activity is within the idle TTL
   * (strict: `now - lastActivity <= TTL`). Otherwise it is evicted —
   * `disposeSession(id)` with NO bus arg (no SSE consumer remains, so no
   * goodbye card), then `disposeBus(id)`. Each eviction is wrapped in
   * try/catch: a failing eviction is counted as skipped and logged, never
   * thrown out of `sweep`.
   *
   * Re-entrant calls are serialized: if a sweep is already in flight, this
   * invocation does NOT start a second concurrent pass — it returns
   * `{ evicted: [], skipped: 0 }` immediately (mirrors the cron runner's
   * `inFlight` guard). The in-flight promise is retained so {@link stop} can
   * await + drain it at shutdown.
   */
  async sweep(): Promise<{ evicted: string[]; skipped: number }> {
    if (this.inFlight !== null) return { evicted: [], skipped: 0 };
    const run = this.runSweep();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  /** The actual sweep pass. Always invoked behind {@link sweep}'s in-flight
   *  guard, never directly, so it never runs concurrently with itself. */
  private async runSweep(): Promise<{ evicted: string[]; skipped: number }> {
    const candidates = new Set([...liveBusSessionIds(), ...this.runtime.sessionContexts.keys()]);
    const evicted: string[] = [];
    let skipped = 0;
    const at = this.now();

    for (const id of candidates) {
      const bus = peekBus(id);
      // A live watcher or an in-flight turn pins the session.
      if (bus !== undefined && (bus.isTurnActive() || bus.getSubscriberCount() > 0)) {
        skipped += 1;
        continue;
      }
      // Prefer the bus's in-memory activity timestamp (epoch ms). Fall back to
      // the persisted row's `lastUpdated` (epoch SECONDS — convert to ms).
      const lastActivity =
        bus !== undefined
          ? bus.getLastActivityAt()
          : (this.runtime.sessionDb.getSession(id)?.lastUpdated ?? 0) * 1000;
      if (at - lastActivity <= this.idleSessionTimeoutMs) {
        skipped += 1;
        continue;
      }
      try {
        await this.runtime.disposeSession(id);
        disposeBus(id);
        evicted.push(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[sessionSupervisor] eviction failed for ${id}: ${msg}\n`);
        skipped += 1;
      }
    }

    return { evicted, skipped };
  }

  /** Arm the background sweep. No-op when disabled or already started. */
  start(): void {
    if (!this.enabled) return;
    if (this.timer !== null) return;
    const timer = setInterval(() => {
      void this.sweep();
    }, this.idleSweepIntervalMs);
    // Don't hold the process open for the sweep — the gateway always has the
    // HTTP server handle live, and tests want a clean exit.
    timer.unref?.();
    this.timer = timer;
  }

  /** Disarm the background sweep and drain any in-flight pass. Idempotent.
   *  Clears the interval first (so no new sweep can be scheduled), then awaits
   *  the in-flight sweep promise — swallowing its errors — so a sweep's DB
   *  reads can never outlive the `sessionDb.close()` that shutdown runs next.
   *  Mirrors the cron runner's stop-then-teardown ordering. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      try {
        await this.inFlight;
      } catch {
        // A failing in-flight sweep must not break shutdown — sweep() already
        // logs per-eviction failures; the pass itself never throws, but guard
        // anyway so stop() always resolves.
      }
    }
  }
}
