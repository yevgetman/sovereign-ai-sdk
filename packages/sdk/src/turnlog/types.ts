// Durable turn logging (spec 2026-07-06-durable-turn-logging-design.md) — the
// canonical, full-content turn-record types. The CONTENT sibling of the assay
// usage wire (`../telemetry/assayUsageRecorder.ts`), but content NEVER rides the
// usage/OTLP path (hard constraint): these records flow ONLY to an embedded,
// pluggable `TurnLogSink` that a platform wires to an immutable store. The
// normalizer (`createTurnLogRecorder`) is harness-agnostic and zero-dependency —
// it is fed the platform's own parsed SSE events (duck-typed on the wire shape),
// so nothing here imports sov-protocol.

/** The four canonical record kinds a turn decomposes into. */
export type TurnLogKind = 'message' | 'thinking' | 'tool_call' | 'tool_result';

/** Who produced the record. */
export type TurnLogRole = 'human' | 'agent' | 'tool';

/**
 * One canonical, full-content turn record.
 *  - `producerRef` is the idempotency key the sink dedupes on:
 *    `${prefix}:${sessionId}:${turnSeq}:${kind}:${ordinal}`.
 *  - `seq` orders records deterministically within a session:
 *    `turnSeq * 1000 + ordinal`.
 */
export type TurnLogRecord = {
  producerRef: string;
  principal: string;
  sessionId: string;
  seq: number;
  kind: TurnLogKind;
  role: TurnLogRole;
  content?: string;
  toolName?: string;
  spanRef?: string;
  taskId?: string;
  source?: unknown;
};

/** The durability port. `record` receives a whole turn's records in ONE call
 *  and owns persistence + idempotent dedup on `producerRef`. */
export type TurnLogSink = { record(records: TurnLogRecord[]): Promise<void> };

/** Structural subset of the sov SSE wire — consumers feed their own parsed
 *  events without importing sov-protocol (duck-typed on the shared wire shape).
 *  `seq` is the turn sequence (turnSeq) the event belongs to. */
export type TurnLogEvent = {
  type: string;
  seq: number;
  block?: number;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  finishReason?: string;
};

/** Fail-open counters (observability only — never thrown). */
export type TurnLogRecorderStats = { committed: number; dropped: number; sinkErrors: number };

export type TurnLogRecorderOptions = {
  sessionId: string;
  principal: string;
  sink: TurnLogSink;
  /** producerRef prefix. Default 'gateway'. */
  producerPrefix?: string;
  /** spanRef stamped on every record. Default `gateway:${sessionId}:${turnSeq}`. */
  spanRefFor?: (turnSeq: number) => string;
  /** Stamped verbatim on every record's `source`. */
  sourceTag?: unknown;
  /** Ordinal cap per turn; records at ordinal >= this are dropped (counted). Default 200. */
  maxRecordsPerTurn?: number;
  /** Observability sink for late / degenerate events. Default: silent (stats only). */
  onError?: (message: string) => void;
};

export type TurnLogRecorder = {
  /** Feed one parsed SSE event. NEVER throws. */
  ingest(ev: TurnLogEvent): void;
  /** Register the human turn text (reserves ordinal 0). */
  setHumanText(turnSeq: number, text: string): void;
  /** Build the turn's records and hand them to the sink in ONE call. NEVER throws. */
  commitTurn(turnSeq: number): Promise<void>;
  /** Drop all accumulated state. */
  abandon(): void;
  /** A snapshot of the fail-open counters. */
  stats(): TurnLogRecorderStats;
};
