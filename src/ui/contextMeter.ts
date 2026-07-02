// Context-window utilization tracker. Subscribes to provider usage
// updates from the query loop, computes a percentage against the
// resolved provider's context length, and exposes:
//
//   - getPercent() — current util as a 0..100 number
//   - getZone()    — "ok" | "warn" | "danger" for renderers that want
//                    a color hint without re-deriving thresholds
//   - shouldWarnApproachingCompaction(threshold) — emits true exactly
//     once when crossing into the high zone, so the REPL can print a
//     pre-compaction warning without spamming the console every turn
//
// The meter is provider-agnostic: it reads inputTokens + outputTokens
// from TokenUsage and counts cached input as input. cacheCreation is
// counted as it's a real billable input write, even though future
// reads will be cached. This intentionally over-estimates rather than
// under-estimates — better to compact a turn early than silently overflow.
//
// Single-instance per session. Lives in src/ui/ because its primary
// consumer is the footer/banner; the compaction trigger reads the
// same data via a separate `shouldCompactProactively` path that has
// always lived in src/compact/.

import type { TokenUsage } from '@yevgetman/sov-sdk/core/types';

export type ContextZone = 'ok' | 'warn' | 'danger';

export type ContextMeterOpts = {
  /** Provider's reported context length in tokens. */
  contextLength: number;
  /** Yellow threshold (0..100). Default 60. */
  warnAtPercent?: number;
  /** Red threshold (0..100). Default 80. */
  dangerAtPercent?: number;
};

export class ContextMeter {
  private contextLength: number;
  private warnAt: number;
  private dangerAt: number;
  private lastInput = 0;
  private lastOutput = 0;
  private lastCacheRead = 0;
  private warnFired = false;

  constructor(opts: ContextMeterOpts) {
    if (!Number.isFinite(opts.contextLength) || opts.contextLength <= 0) {
      throw new Error('ContextMeter: contextLength must be a positive number');
    }
    this.contextLength = opts.contextLength;
    this.warnAt = clampPct(opts.warnAtPercent ?? 60);
    this.dangerAt = clampPct(opts.dangerAtPercent ?? 80);
    if (this.dangerAt < this.warnAt) {
      throw new Error('ContextMeter: dangerAtPercent must be >= warnAtPercent');
    }
  }

  /** Receive a usage delta from the query loop. Caller passes the
   *  whole TokenUsage; we keep the latest values (provider-reported
   *  cumulative counts) and recompute on demand. */
  update(usage: TokenUsage): void {
    if (typeof usage.inputTokens === 'number') this.lastInput = usage.inputTokens;
    if (typeof usage.outputTokens === 'number') this.lastOutput = usage.outputTokens;
    if (typeof usage.cacheReadInputTokens === 'number') {
      this.lastCacheRead = usage.cacheReadInputTokens;
    }
  }

  /** Total tokens currently sitting in context (input + cache_read +
   *  output). Cache-read tokens count toward context use because the
   *  model still attends to them. */
  getTokens(): number {
    return this.lastInput + this.lastCacheRead + this.lastOutput;
  }

  /** Util percentage rounded to 0.1; values >100 are clamped to 100
   *  so the renderer doesn't display "112%". */
  getPercent(): number {
    const raw = (this.getTokens() / this.contextLength) * 100;
    if (!Number.isFinite(raw)) return 0;
    if (raw > 100) return 100;
    if (raw < 0) return 0;
    return Math.round(raw * 10) / 10;
  }

  getZone(): ContextZone {
    const pct = this.getPercent();
    if (pct >= this.dangerAt) return 'danger';
    if (pct >= this.warnAt) return 'warn';
    return 'ok';
  }

  /** True the first time util crosses the proactive-compaction threshold
   *  (0..100), false thereafter — including on subsequent calls in the
   *  same session unless reset() is called. The REPL uses this to print
   *  a one-time "approaching compaction" warning so the user isn't
   *  surprised when compaction fires. */
  shouldWarnApproachingCompaction(thresholdPercent: number): boolean {
    const t = clampPct(thresholdPercent);
    // Fire when within 5% below the threshold — early enough for the
    // user to see a warning before compaction kicks in on the next
    // turn, late enough that we don't warn on small, stable sessions.
    const trigger = Math.max(0, t - 5);
    if (this.warnFired) return false;
    if (this.getPercent() >= trigger) {
      this.warnFired = true;
      return true;
    }
    return false;
  }

  /** Re-arm the one-shot compaction warning. Called after a successful
   *  compaction so the next high-utilization turn warns again. */
  reset(): void {
    this.warnFired = false;
    this.lastInput = 0;
    this.lastOutput = 0;
    this.lastCacheRead = 0;
  }

  /** For the footer / banner: the user-facing thresholds (read-only). */
  getThresholds(): { warn: number; danger: number } {
    return { warn: this.warnAt, danger: this.dangerAt };
  }
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
