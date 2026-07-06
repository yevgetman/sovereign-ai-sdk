// Durable turn logging (spec 2026-07-06) — `createTurnLogRecorder`, the
// harness-agnostic normalizer that turns a gateway's parsed SSE event stream
// into canonical full-content turn records and hands each turn's records to a
// pluggable `TurnLogSink` in ONE call. Zero dependencies.
//
// Open-turn accumulation (the REAL wire): on the sov gateway `seq` is a
// per-EVENT monotonic counter (text_delta seq=99, tool_use_done seq=95, …), NOT
// a per-turn value — only the terminal `turn_complete` carries the turn's seq.
// So "everything since the last turn_complete belongs to that turn" (the gateway
// is single-threaded per session): every content event appends to a SINGLE open
// accumulation; `turn_complete` SEALS that slot under its seq and rolls a fresh
// open one; `commitTurn(seq)` flushes only the sealed slot for that seq. `block`
// still groups intra-turn units (thinking blocks; tool_use start/done pairing)
// WITHIN the open accumulation; arrival order still drives ordinals.
//
// Fail-open discipline (mirrors ../telemetry/assayUsageRecorder.ts): `ingest`,
// `setHumanText`, and `commitTurn` NEVER throw into the caller — a sink failure
// increments `sinkErrors`, notifies `onError`, and is swallowed. Content NEVER
// rides the usage/OTLP wire — this module is the CONTENT sibling and touches no
// telemetry path.
//
// Ordinal model (deterministic, replay-idempotent producerRefs):
//   - ordinal 0 is RESERVED for the human message (even if setHumanText arrives
//     after deltas);
//   - each intermediate unit (thinking block, tool_call block, tool_result)
//     takes the next ordinal at FIRST ARRIVAL (1..n, arrival order);
//   - the agent message ALWAYS takes the LAST ordinal, assigned at commit;
//   - seq = turnSeq * 1000 + ordinal.
import type {
  TurnLogEvent,
  TurnLogKind,
  TurnLogRecord,
  TurnLogRecorder,
  TurnLogRecorderOptions,
  TurnLogRecorderStats,
  TurnLogRole,
} from './types.js';

const DEFAULT_PRODUCER_PREFIX = 'gateway';
const DEFAULT_MAX_RECORDS_PER_TURN = 200;
/** seq = turnSeq * SEQ_TURN_STRIDE + ordinal (deterministic within-session order). */
const SEQ_TURN_STRIDE = 1000;
/** Ordinal 0 is reserved for the human message. */
const HUMAN_ORDINAL = 0;
/** Intermediate units (thinking / tool_call / tool_result) start here. */
const FIRST_INTERMEDIATE_ORDINAL = 1;
/** Cap on retained sealed (uncommitted) turn slots. A historical replay streams
 *  many turn_completes whose slots are never committed; drop-oldest bounds
 *  memory (each eviction is counted in stats.dropped). */
const MAX_SEALED_SLOTS = 4;

type ThinkingUnit = { kind: 'thinking'; ordinal: number; text: string };
type ToolCallUnit = {
  kind: 'tool_call';
  ordinal: number;
  toolName: string;
  hasInput: boolean;
  input: unknown;
};
type ToolResultUnit = { kind: 'tool_result'; ordinal: number; toolName: string; content: string };
type IntermediateUnit = ThinkingUnit | ToolCallUnit | ToolResultUnit;

/** Everything accumulated for one turn (open, then sealed at turn_complete). */
type TurnState = {
  humanText: string | null;
  agentText: string;
  nextOrdinal: number;
  intermediates: IntermediateUnit[];
  thinkingByBlock: Map<number, ThinkingUnit>;
  toolCallByBlock: Map<number, ToolCallUnit>;
};

function newTurnState(): TurnState {
  return {
    humanText: null,
    agentText: '',
    nextOrdinal: FIRST_INTERMEDIATE_ORDINAL,
    intermediates: [],
    thinkingByBlock: new Map(),
    toolCallByBlock: new Map(),
  };
}

const isBlank = (s: string | undefined): boolean => s === undefined || s.trim() === '';

/** tool_result content: raw string passthrough, else JSON. `undefined` for a
 *  value JSON.stringify cannot represent (e.g. undefined) → skipped at commit. */
function stringifyOutput(output: unknown): string | undefined {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createTurnLogRecorder(opts: TurnLogRecorderOptions): TurnLogRecorder {
  const { sessionId, principal, sink } = opts;
  const producerPrefix = opts.producerPrefix ?? DEFAULT_PRODUCER_PREFIX;
  const maxRecordsPerTurn = opts.maxRecordsPerTurn ?? DEFAULT_MAX_RECORDS_PER_TURN;
  const spanRefFor =
    opts.spanRefFor ?? ((turnSeq: number): string => `gateway:${sessionId}:${turnSeq}`);
  const onError = opts.onError ?? ((): void => {});
  const sourceTag = opts.sourceTag;

  // The single OPEN accumulation: every content event since the last
  // turn_complete belongs here (the event's own per-event seq no longer selects
  // a bucket). Sealed slots (turn_complete'd, awaiting commit) are keyed by the
  // turn's seq; insertion order == Map iteration order drives drop-oldest.
  let open = newTurnState();
  const sealed = new Map<number, TurnState>();
  const stats: TurnLogRecorderStats = { committed: 0, dropped: 0, sinkErrors: 0 };

  function newToolCall(state: TurnState, block: number, toolName: string): ToolCallUnit {
    const unit: ToolCallUnit = {
      kind: 'tool_call',
      ordinal: state.nextOrdinal,
      toolName,
      hasInput: false,
      input: undefined,
    };
    state.nextOrdinal += 1;
    state.toolCallByBlock.set(block, unit);
    state.intermediates.push(unit);
    return unit;
  }

  /** Append a content event to the open accumulation. `turn_complete` is routed
   *  by `ingest` before this and never reaches here. */
  function handleContent(ev: TurnLogEvent): void {
    const state = open;
    switch (ev.type) {
      case 'thinking_delta': {
        const block = ev.block ?? 0;
        let unit = state.thinkingByBlock.get(block);
        if (unit === undefined) {
          unit = { kind: 'thinking', ordinal: state.nextOrdinal, text: '' };
          state.nextOrdinal += 1;
          state.thinkingByBlock.set(block, unit);
          state.intermediates.push(unit);
        }
        unit.text += ev.text ?? '';
        break;
      }
      case 'tool_use_start': {
        const block = ev.block ?? 0;
        const existing = state.toolCallByBlock.get(block);
        if (existing === undefined) {
          newToolCall(state, block, ev.tool ?? 'unknown');
        } else if (ev.tool !== undefined) {
          existing.toolName = ev.tool;
        }
        break;
      }
      case 'tool_use_done': {
        const block = ev.block ?? 0;
        let unit = state.toolCallByBlock.get(block);
        if (unit === undefined) {
          unit = newToolCall(state, block, ev.tool ?? 'unknown');
          onError(
            `turnlog: tool_use_done without tool_use_start (block ${block}) — toolName 'unknown'`,
          );
        }
        unit.input = ev.input;
        unit.hasInput = true;
        break;
      }
      case 'tool_result': {
        const unit: ToolResultUnit = {
          kind: 'tool_result',
          ordinal: state.nextOrdinal,
          toolName: ev.tool ?? 'unknown',
          content: stringifyOutput(ev.output) ?? '',
        };
        state.nextOrdinal += 1;
        state.intermediates.push(unit);
        break;
      }
      case 'text_delta': {
        state.agentText += ev.text ?? '';
        break;
      }
      default:
        break; // unknown events — forward-compatible passthrough (ignored)
    }
  }

  /** Seal the open accumulation under `seq` and roll a fresh open one. Enforces
   *  the sealed-slot cap by dropping the oldest slot (counted). */
  function sealOpen(seq: number): void {
    sealed.set(seq, open);
    open = newTurnState();
    while (sealed.size > MAX_SEALED_SLOTS) {
      const oldest = sealed.keys().next().value as number;
      sealed.delete(oldest);
      stats.dropped += 1; // an uncommitted historical slot evicted to bound memory
    }
  }

  function buildRecord(
    turnSeq: number,
    ordinal: number,
    kind: TurnLogKind,
    role: TurnLogRole,
    content: string,
    toolName: string | undefined,
  ): TurnLogRecord {
    const record: TurnLogRecord = {
      producerRef: `${producerPrefix}:${sessionId}:${turnSeq}:${kind}:${ordinal}`,
      principal,
      sessionId,
      seq: turnSeq * SEQ_TURN_STRIDE + ordinal,
      kind,
      role,
      content,
      spanRef: spanRefFor(turnSeq),
    };
    if (toolName !== undefined) record.toolName = toolName;
    if (sourceTag !== undefined) record.source = sourceTag;
    return record;
  }

  function collect(state: TurnState, turnSeq: number): TurnLogRecord[] {
    const batch: TurnLogRecord[] = [];
    const consider = (
      ordinal: number,
      kind: TurnLogKind,
      role: TurnLogRole,
      content: string | undefined,
      toolName: string | undefined,
    ): void => {
      // Empty / whitespace-only content is skipped (NOT a drop). tool_call's
      // content is the JSON input, so `{}` is non-blank and survives naturally.
      if (isBlank(content)) return;
      if (ordinal >= maxRecordsPerTurn) {
        stats.dropped += 1; // beyond the per-turn cap — dropped + counted
        return;
      }
      batch.push(buildRecord(turnSeq, ordinal, kind, role, content as string, toolName));
    };

    // Ordinal 0 — the human message.
    if (state.humanText !== null)
      consider(HUMAN_ORDINAL, 'message', 'human', state.humanText, undefined);
    // Intermediates, in first-arrival (== ordinal) order.
    for (const unit of state.intermediates) {
      if (unit.kind === 'thinking') {
        consider(unit.ordinal, 'thinking', 'agent', unit.text, undefined);
      } else if (unit.kind === 'tool_call') {
        const content = unit.hasInput ? JSON.stringify(unit.input) : undefined;
        consider(unit.ordinal, 'tool_call', 'agent', content, unit.toolName);
      } else {
        consider(unit.ordinal, 'tool_result', 'tool', unit.content, unit.toolName);
      }
    }
    // The agent message — ALWAYS last.
    consider(state.nextOrdinal, 'message', 'agent', state.agentText, undefined);
    return batch;
  }

  async function commitTurn(turnSeq: number): Promise<void> {
    const state = sealed.get(turnSeq);
    if (state === undefined) return; // no sealed slot — replay-safe, the sink is not called
    sealed.delete(turnSeq); // the slot is cleared BEFORE the sink call

    let batch: TurnLogRecord[];
    try {
      batch = collect(state, turnSeq);
    } catch (err) {
      onError(`turnlog: commit build failed: ${errMsg(err)}`);
      return;
    }
    if (batch.length === 0) return; // no non-empty records — the sink is not called

    try {
      await sink.record(batch);
      stats.committed += batch.length;
    } catch (err) {
      stats.sinkErrors += 1;
      onError(`turnlog: sink.record failed: ${errMsg(err)}`);
    }
  }

  return {
    ingest(ev: TurnLogEvent): void {
      // NEVER throw into the caller — the ingest contract.
      try {
        if (ev.type === 'turn_complete') {
          sealOpen(ev.seq);
          return;
        }
        handleContent(ev);
      } catch (err) {
        onError(`turnlog: ingest failed: ${errMsg(err)}`);
      }
    },
    setHumanText(turnSeq: number, text: string): void {
      try {
        // The platform calls this AFTER the turn_complete arrived, so the sealed
        // slot is the live path; the open accumulation is the pre-seal fallback.
        const slot = sealed.get(turnSeq);
        if (slot !== undefined) slot.humanText = text;
        else open.humanText = text;
      } catch (err) {
        onError(`turnlog: setHumanText failed: ${errMsg(err)}`);
      }
    },
    commitTurn,
    abandon(): void {
      open = newTurnState();
      sealed.clear();
    },
    stats(): TurnLogRecorderStats {
      return { ...stats };
    },
  };
}
