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
  /** Reserved for the concurrency-cap policy (a later Phase D task). Captured
   *  here so the gateway wiring contract is stable; not yet consulted by
   *  `sweep`. */
  private readonly maxConcurrentSessions: number | undefined;
  private readonly enabled: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SupervisorOpts) {
    this.runtime = opts.runtime;
    this.now = opts.now ?? (() => Date.now());
    this.idleSessionTimeoutMs = opts.idleSessionTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleSweepIntervalMs = opts.idleSweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxConcurrentSessions = opts.maxConcurrentSessions;
    this.enabled = opts.enabled ?? true;
  }

  /** The configured concurrency cap, if any. Surfaced so the gateway wiring
   *  (and a later cap-enforcement task) can read it back; `sweep` does not yet
   *  consult it. */
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
   */
  async sweep(): Promise<{ evicted: string[]; skipped: number }> {
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

  /** Disarm the background sweep. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
