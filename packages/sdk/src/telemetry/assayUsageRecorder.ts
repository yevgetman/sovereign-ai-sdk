// Assay usage recorder (spec 2026-07-05-assay-integration-design.md) — the SDK's
// official token-accounting wire. A `traceRecorder` implementation that converts
// the trace events the SDK already emits into OpenTelemetry `gen_ai` spans and
// POSTs them as OTLP/JSON to a local `assay serve` endpoint (SOV-ASSAY WIRE v1).
//
// USAGE ONLY — no content ever flows here: token counts, identities, tool names,
// timings. Zero dependencies (hand-rolled OTLP/JSON — assay parses the same shape).
// Fire-and-forget: `record` NEVER throws into the agent loop, failures retry once
// then drop (counted), the queue is bounded (drop-oldest, counted), and the flush
// timer is unref'd so the exporter never keeps a process alive.
//
// Span grain (the contract):
//   - ONE chat span per provider_response — the priced unit. It carries the five
//     phase-broken usage fields and `gen_ai.tool.name` = the DOMINANT tool its
//     completion invoked (observed via the one-response lag: tools that run after
//     response N belong to N; the span is sealed when the next response / turn /
//     session boundary arrives).
//   - ONE execute_tool span per tool_end/tool_error (identity + timing, no
//     tokens — assay records it honestly as unpriced).
//   - traceId = sha256(sessionId#turn) and `sov.turn.id` = "sessionId#turn", so
//     assay's per-tenant `taskIdAttribute` yields per-TURN task attribution that
//     is batch-split-proof. spanId = sha256(sessionId#seq) — DETERMINISTIC ids,
//     so a replayed export dedupes on assay's producer_ref (idempotent).
import { createHash, randomUUID } from 'node:crypto';
import type { TokenUsage } from '../core/types.js';
import type { TraceEvent } from '../trace/types.js';

/** The wire-contract version stamped on every span (`sov.telemetry.version`). */
export const ASSAY_WIRE_VERSION = 1;

/** Default endpoint — `assay serve`'s OTLP/HTTP convention port, loopback. */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318';
const DEFAULT_IDENTITY = 'sov';
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BUFFERED = 2_048;

export type AssayUsageRecorderConfig = {
  /** The assay tenant bearer token (assay serve authenticates every POST). */
  token: string;
  /** OTLP/HTTP base URL; `/v1/traces` is appended. Default: local assay serve. */
  endpoint?: string;
  /** Lands as `gen_ai.agent.id` → assay's principal (tenant-namespaced). */
  identity?: string;
  /** Emit execute_tool spans (identity + timing, unpriced). Default true. */
  emitToolSpans?: boolean;
  /** Queued spans that trigger an immediate send. Default 64. */
  batchSize?: number;
  /** Periodic flush interval (ms); the timer is unref'd. Default 5000. */
  flushIntervalMs?: number;
  /** Queue bound — beyond it the OLDEST spans drop (counted). Default 2048. */
  maxBuffered?: number;
  /** Injectable transport (tests). Default: global fetch. */
  fetch?: typeof fetch;
  /** Observability sink for transport/drop errors. Default: silent (stats only). */
  onError?: (message: string) => void;
};

export type AssayExportStats = {
  /** Spans accepted by the endpoint (2xx). */
  exported: number;
  /** Spans currently queued (incl. one pending retry batch). */
  buffered: number;
  /** Spans dropped — queue overflow or a batch that failed twice. */
  dropped: number;
  /** Failed POST attempts (a batch failing twice counts two). */
  failed: number;
};

export type AssayUsageRecorder = {
  /** The `traceRecorder` sink — pass as `config.traceRecorder`. Never throws. */
  record: (event: TraceEvent) => void;
  /** Seal any pending span and drain the queue (await before process exit). */
  flush: () => Promise<void>;
  stats: () => AssayExportStats;
};

/** One OTLP/JSON span (only the fields assay's door reads). */
type OtlpJsonSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue: string } | { intValue: string } }>;
};

/** A provider_response awaiting its tool attribution (sealed at the next boundary). */
type PendingChatSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  turnId: string;
  provider: string;
  model: string;
  purpose: string;
  usage: TokenUsage;
  stopReason: string;
  iso: string;
  latencyMs: number;
  tools: string[];
};

const strAttr = (key: string, v: string) => ({ key, value: { stringValue: v } });
const intAttr = (key: string, v: number) => ({ key, value: { intValue: String(v) } });

/** ms epoch → OTLP nanosecond string (exact — appends the ns zeros). */
const nanos = (ms: number): string => `${ms}000000`;

const hexId = (input: string, chars: number): string =>
  createHash('sha256').update(input).digest('hex').slice(0, chars);

/** The most frequent tool; ties break to the FIRST tied tool in invocation order
 *  (the same dominant-tool rule assay's turns-derived classifier pins). */
export function dominantTool(tools: readonly string[]): string | undefined {
  if (tools.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  let best = tools[0] as string;
  let bestCount = 0;
  for (const [tool, count] of counts) {
    if (count > bestCount) {
      best = tool;
      bestCount = count;
    }
  }
  return best;
}

/** TokenUsage field → gen_ai usage attribute (assay's TokenPhases names). */
const USAGE_ATTRS: ReadonlyArray<[keyof TokenUsage, string]> = [
  ['inputTokens', 'gen_ai.usage.input_tokens'],
  ['outputTokens', 'gen_ai.usage.output_tokens'],
  ['cacheReadInputTokens', 'gen_ai.usage.cache_read_tokens'],
  ['cacheCreationInputTokens', 'gen_ai.usage.cache_creation_tokens'],
  ['reasoningTokens', 'gen_ai.usage.reasoning_tokens'],
];

/**
 * Build the recorder. Create ONE per run/session (state is session-affine; a new
 * `session_start` defensively seals + flushes prior state).
 */
export function createAssayUsageRecorder(config: AssayUsageRecorderConfig): AssayUsageRecorder {
  const endpoint = `${(config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')}/v1/traces`;
  const identity = config.identity ?? DEFAULT_IDENTITY;
  const emitToolSpans = config.emitToolSpans ?? true;
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBuffered = config.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  const doFetch = config.fetch ?? fetch;
  const onError = config.onError ?? (() => {});

  // ── session-affine state ──
  let sessionId: string = randomUUID(); // stand-in until session_start names the real one
  let turn = 0;
  // SESSION-MONOTONIC turn ordinal (advances on every turn_start, never resets).
  // The server driver (query()) restarts its OWN per-invocation loop counter at 0
  // on every user turn (a fresh query() per POST /turns), so copying `event.turn`
  // would collide `sov.turn.id`/`traceId` across sequential user turns and merge
  // independent priced turns into one assay task. Deriving `turn` from this
  // monotonic counter instead makes every turn's ids distinct within a session.
  // (For the golden-fixture stream — turn_start turns 1 then 2 — the counter
  // yields exactly 1 then 2, so the wire fixture stays byte-identical.)
  let turnCounter = 0;
  let seq = 0;
  let turnRootSpanId: string | undefined;
  let pending: PendingChatSpan | null = null;

  // ── transport state ──
  const queue: OtlpJsonSpan[] = [];
  let retryBatch: OtlpJsonSpan[] | null = null; // one failed batch awaiting its single retry
  let sending: Promise<void> = Promise.resolve(); // serializes sends
  const stats: AssayExportStats = { exported: 0, buffered: 0, dropped: 0, failed: 0 };

  // Domain-separated hash inputs ('turn:'/'span:') so a spanId never shares
  // bytes with a traceId derived from the same session+ordinal.
  const traceId = (): string => hexId(`turn:${sessionId}#${turn}`, 32);
  const nextSpanId = (): string => {
    seq += 1;
    return hexId(`span:${sessionId}#${seq}`, 16);
  };
  const turnId = (): string => `${sessionId}#${turn}`;

  function commonAttrs(provider: string, tid: string): OtlpJsonSpan['attributes'] {
    return [
      strAttr('gen_ai.provider.name', provider),
      strAttr('gen_ai.conversation.id', sessionId),
      strAttr('gen_ai.agent.id', identity),
      strAttr('sov.turn.id', tid),
      intAttr('sov.telemetry.version', ASSAY_WIRE_VERSION),
    ];
  }

  /** Seal the pending chat span (attach dominant tool) and queue it. */
  function sealPending(): void {
    if (pending === null) return;
    const p = pending;
    pending = null;
    const endMs = Date.parse(p.iso);
    const attrs = [
      ...commonAttrs(p.provider, p.turnId),
      strAttr('gen_ai.operation.name', 'chat'),
      strAttr('gen_ai.request.model', p.model),
      strAttr('sov.purpose', p.purpose),
      strAttr('sov.stop_reason', p.stopReason),
      intAttr('sov.latency_ms', p.latencyMs),
    ];
    for (const [field, attrName] of USAGE_ATTRS) {
      const v = p.usage[field];
      if (v !== undefined) attrs.push(intAttr(attrName, v));
    }
    const tool = dominantTool(p.tools);
    if (tool !== undefined) attrs.push(strAttr('gen_ai.tool.name', tool));
    enqueue({
      traceId: p.traceId,
      spanId: p.spanId,
      ...(p.parentSpanId !== undefined ? { parentSpanId: p.parentSpanId } : {}),
      name: `chat ${p.model}`,
      startTimeUnixNano: nanos(endMs - p.latencyMs),
      endTimeUnixNano: nanos(endMs),
      attributes: attrs,
    });
  }

  function enqueue(span: OtlpJsonSpan): void {
    queue.push(span);
    if (queue.length > maxBuffered) {
      const overflow = queue.length - maxBuffered;
      queue.splice(0, overflow);
      stats.dropped += overflow;
      onError(`assay exporter: queue overflow — dropped ${overflow} oldest span(s)`);
    }
    if (queue.length >= batchSize) void send();
  }

  /** Serialize sends; a failed batch waits in `retryBatch` for exactly one retry. */
  function send(): Promise<void> {
    sending = sending.then(async () => {
      const batch = retryBatch ?? queue.splice(0, queue.length);
      const isRetry = retryBatch !== null;
      retryBatch = null;
      if (batch.length === 0) return;
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.token}`,
          },
          redirect: 'error',
          body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: batch }] }] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        stats.exported += batch.length;
      } catch (err) {
        stats.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (isRetry) {
          stats.dropped += batch.length;
          onError(`assay exporter: batch dropped after retry (${batch.length} spans): ${msg}`);
        } else {
          retryBatch = batch; // one retry on the next send/flush
          onError(`assay exporter: POST failed (will retry once): ${msg}`);
        }
      }
    });
    return sending;
  }

  // Periodic flush — unref'd so the exporter never keeps the process alive.
  const timer = setInterval(() => void send(), config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();

  function handle(event: TraceEvent): void {
    switch (event.type) {
      case 'session_start': {
        sealPending();
        void send();
        sessionId = event.sessionId;
        turn = 0;
        turnRootSpanId = undefined;
        break;
      }
      case 'turn_start': {
        sealPending();
        // Monotonic — see turnCounter. Ignores event.turn (query resets it to 0
        // per user turn) so sequential user turns get distinct trace/turn ids.
        turn = ++turnCounter;
        turnRootSpanId = undefined;
        break;
      }
      case 'provider_response': {
        sealPending();
        const spanId = nextSpanId();
        pending = {
          traceId: traceId(),
          spanId,
          ...(turnRootSpanId !== undefined ? { parentSpanId: turnRootSpanId } : {}),
          turnId: turnId(),
          provider: event.provider,
          model: event.model,
          purpose: event.purpose,
          usage: event.usage,
          stopReason: event.stopReason,
          iso: event.iso,
          latencyMs: event.latencyMs,
          tools: [],
        };
        if (turnRootSpanId === undefined) turnRootSpanId = spanId;
        break;
      }
      case 'tool_end':
      case 'tool_error': {
        // An errored tool was still invoked — both attribute + (optionally) emit.
        pending?.tools.push(event.tool);
        if (!emitToolSpans) break;
        const endMs = Date.parse(event.iso);
        enqueue({
          traceId: traceId(),
          spanId: nextSpanId(),
          ...(pending !== undefined && pending !== null
            ? { parentSpanId: pending.spanId }
            : turnRootSpanId !== undefined
              ? { parentSpanId: turnRootSpanId }
              : {}),
          name: `execute_tool ${event.tool}`,
          startTimeUnixNano: nanos(endMs - event.durationMs),
          endTimeUnixNano: nanos(endMs),
          attributes: [
            ...commonAttrs('sov', turnId()),
            strAttr('gen_ai.operation.name', 'execute_tool'),
            strAttr('gen_ai.tool.name', event.tool),
            intAttr('sov.duration_ms', event.durationMs),
            ...(event.type === 'tool_end'
              ? [intAttr('sov.output_bytes', event.outputBytes)]
              : [strAttr('sov.error', event.message.slice(0, 256))]),
          ],
        });
        break;
      }
      case 'session_end': {
        sealPending();
        void send();
        break;
      }
      default:
        break; // every other trace event is out of this wire's scope
    }
    stats.buffered = queue.length + (retryBatch?.length ?? 0);
  }

  return {
    record(event: TraceEvent): void {
      // NEVER throw into the agent loop — the traceRecorder contract.
      try {
        handle(event);
      } catch (err) {
        onError(
          `assay exporter: record failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    async flush(): Promise<void> {
      sealPending();
      // Two passes: the queued batch, then a possible retryBatch left by a failure.
      await send();
      if (retryBatch !== null || queue.length > 0) await send();
      stats.buffered = queue.length + (retryBatch?.length ?? 0);
    },
    stats(): AssayExportStats {
      return { ...stats, buffered: queue.length + (retryBatch?.length ?? 0) };
    },
  };
}
