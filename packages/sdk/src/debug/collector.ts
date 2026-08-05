// The debug collector: the in-memory hub the console reads.
//
// This is deliberately NOT a durable log. A host's durable record is its own
// (assay spans, sealed transcripts, whatever it keeps); duplicating it here
// would create a second source of truth that drifts. This is the last ~100
// dispatch facts per principal, in memory, for a person watching a live run.
//
// MEMORY IS BOUNDED BY CONSTRUCTION, NOT BY HOPE: a ring per principal and an
// LRU cap on principals. A restart empties it, and the console's footer says so.

import type {
  AgentDebugEvent,
  RecordInput,
  TelemetryEvent,
  TelemetryInput,
  TurnDetailEvent,
  TurnDetailInput,
} from './types.js';

export interface DebugCollector {
  /** Record a dispatch. NEVER THROWS — debug capture must not fail a turn. */
  record(input: RecordInput): void;
  /**
   * Record an under-the-hood turn detail, deduped on the gateway's per-session
   * event seq. THE REPLAY GUARD: a follower re-streams session history on every
   * turn, and without the high-water mark each replay re-records every old
   * event — the feed fills with duplicates and the real turn is lost in them.
   */
  recordDetail(principal: string, event: TurnDetailInput): void;
  /** Record an app-usage fact. Never throws. */
  recordTelemetry(input: TelemetryInput): void;
  /** The principal's dispatch feed, newest first. */
  feedFor(principal: string): AgentDebugEvent[];
  /** The principal's turn details, newest first. */
  detailsFor(principal: string): TurnDetailEvent[];
  /** The principal's telemetry, newest first. */
  telemetryFor(principal: string): TelemetryEvent[];
}

export interface DebugCollectorOptions {
  /** Dispatch rows kept per principal (default 100). */
  eventsPerPrincipal?: number;
  /** Turn details kept per principal (default 300). */
  detailsPerPrincipal?: number;
  /** Telemetry rows kept per principal (default 300). */
  telemetryPerPrincipal?: number;
  /** Principals tracked before the least-recent is evicted (default 20). */
  maxPrincipals?: number;
  now?: () => Date;
  /**
   * A durability sink, called after every telemetry push with the stamped
   * event. Whatever is behind it decides what is worth keeping; the collector
   * stays storage-free. It MUST NOT THROW — and is guarded anyway, because the
   * never-fail contract outranks any sink.
   */
  onTelemetry?: (principal: string, event: TelemetryEvent) => void;
}

const DEFAULT_EVENTS = 100;
const DEFAULT_DETAILS = 300;
const DEFAULT_TELEMETRY = 300;
const DEFAULT_MAX_PRINCIPALS = 20;
const PREVIEW_CHARS = 80;
const DETAIL_CHARS = 200;

/** A no-op collector for compositions that don't wire one (tests, workers). */
export const NULL_DEBUG_COLLECTOR: DebugCollector = {
  record: () => {},
  recordDetail: () => {},
  recordTelemetry: () => {},
  feedFor: () => [],
  detailsFor: () => [],
  telemetryFor: () => [],
};

/** One principal's three rings plus the per-session replay watermark. */
interface PrincipalRings {
  turns: AgentDebugEvent[];
  details: TurnDetailEvent[];
  telemetry: TelemetryEvent[];
  /** sessionId → highest gateway event seq already recorded. */
  detailWatermarks: Map<string, number>;
}

export function createDebugCollector(options: DebugCollectorOptions = {}): DebugCollector {
  const now = options.now ?? (() => new Date());
  const eventsCap = options.eventsPerPrincipal ?? DEFAULT_EVENTS;
  const detailsCap = options.detailsPerPrincipal ?? DEFAULT_DETAILS;
  const telemetryCap = options.telemetryPerPrincipal ?? DEFAULT_TELEMETRY;
  const maxPrincipals = options.maxPrincipals ?? DEFAULT_MAX_PRINCIPALS;

  // Map iteration order is insertion order, which is what makes the LRU below
  // one delete+set rather than a separate bookkeeping structure.
  const rings = new Map<string, PrincipalRings>();
  let seq = 0;

  /** Get-or-create a principal's rings, refreshing LRU recency either way. */
  function ringsFor(principal: string): PrincipalRings {
    const existing = rings.get(principal);
    if (existing !== undefined) {
      rings.delete(principal);
      rings.set(principal, existing);
      return existing;
    }
    if (rings.size >= maxPrincipals) {
      const oldest = rings.keys().next().value;
      if (oldest !== undefined) rings.delete(oldest);
    }
    const fresh: PrincipalRings = {
      turns: [],
      details: [],
      telemetry: [],
      detailWatermarks: new Map(),
    };
    rings.set(principal, fresh);
    return fresh;
  }

  function push<T>(ring: T[], event: T, cap: number): void {
    ring.push(event);
    if (ring.length > cap) ring.shift();
  }

  return {
    record(input: RecordInput): void {
      try {
        seq += 1;
        push(
          ringsFor(input.principal).turns,
          {
            at: now().toISOString(),
            sessionId: input.sessionId,
            surface: input.surface,
            ...(input.lane !== undefined ? { lane: input.lane } : {}),
            model: input.model,
            workflow: input.workflow ?? null,
            preview: (input.text ?? '').slice(0, PREVIEW_CHARS),
            seq,
          },
          eventsCap,
        );
      } catch {
        // Debug capture must never fail a turn. Nothing here should throw, but
        // the contract is worth more than the stack trace.
      }
    },

    recordDetail(principal, event): void {
      try {
        const rings = ringsFor(principal);
        const mark = rings.detailWatermarks.get(event.sessionId) ?? 0;
        if (event.eventSeq <= mark) return;
        rings.detailWatermarks.set(event.sessionId, event.eventSeq);

        seq += 1;
        push(
          rings.details,
          { ...event, at: now().toISOString(), seq } as TurnDetailEvent,
          detailsCap,
        );
      } catch {
        // Same contract as record().
      }
    },

    recordTelemetry(input: TelemetryInput): void {
      try {
        seq += 1;
        const event: TelemetryEvent = {
          at: now().toISOString(),
          category: input.category,
          name: input.name.slice(0, DETAIL_CHARS),
          detail: (input.detail ?? '').slice(0, DETAIL_CHARS),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
          seq,
        };
        push(ringsFor(input.principal).telemetry, event, telemetryCap);
        options.onTelemetry?.(input.principal, event);
      } catch {
        // Same contract as record().
      }
    },

    feedFor(principal: string): AgentDebugEvent[] {
      return [...(rings.get(principal)?.turns ?? [])].reverse();
    },
    detailsFor(principal: string): TurnDetailEvent[] {
      return [...(rings.get(principal)?.details ?? [])].reverse();
    },
    telemetryFor(principal: string): TelemetryEvent[] {
      return [...(rings.get(principal)?.telemetry ?? [])].reverse();
    },
  };
}
