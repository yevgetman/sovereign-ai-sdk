// Durable turn logging (spec 2026-07-06) — the `createTurnLogRecorder`
// normalizer. It turns the gateway's parsed SSE event stream into canonical
// full-content turn records (message / thinking / tool_call / tool_result) and
// hands each turn's records to a pluggable, embedded-only `TurnLogSink` in ONE
// call. Covers:
//   • full-turn normalization: human + thinking(×2 same block) + tool call +
//     tool result + agent message → 5 records with the exact kinds / roles /
//     seqs / producerRefs / spanRef the platform consumes;
//   • multi-block thinking (block-arrival ordinal order);
//   • a tool_use_done with no matching start (toolName 'unknown' + onError);
//   • fail-open sink: a throwing sink resolves, counts a sinkError, clears state;
//   • determinism (replay yields byte-identical producerRefs/seqs — the sink
//     dedupes on producerRef);
//   • the per-turn ordinal cap (excess dropped + counted);
//   • abandon() (drops accumulated state);
//   • an empty turn (no content → the sink is never called).
import { describe, expect, it } from 'bun:test';
import { createTurnLogRecorder } from '../src/turnlog/recorder.js';
import type { TurnLogRecord, TurnLogRecorder, TurnLogSink } from '../src/turnlog/types.js';

/** A capture sink: records every batch handed to it (never throws). */
function captureSink(): {
  sink: TurnLogSink;
  batches: TurnLogRecord[][];
  callCount: () => number;
} {
  const batches: TurnLogRecord[][] = [];
  let calls = 0;
  const sink: TurnLogSink = {
    async record(records: TurnLogRecord[]): Promise<void> {
      calls += 1;
      batches.push(records);
    },
  };
  return { sink, batches, callCount: () => calls };
}

/** A sink that always rejects — exercises the recorder's fail-open discipline. */
function throwingSink(): { sink: TurnLogSink; callCount: () => number } {
  let calls = 0;
  const sink: TurnLogSink = {
    async record(): Promise<void> {
      calls += 1;
      throw new Error('sink boom');
    },
  };
  return { sink, callCount: () => calls };
}

/** The canonical full turn: human text, two thinking deltas on ONE block, a
 *  matched tool call, a tool result, and two agent text deltas. */
function driveFullTurn(rec: TurnLogRecorder, turnSeq: number): void {
  rec.setHumanText(turnSeq, 'hello world');
  rec.ingest({ type: 'thinking_delta', seq: turnSeq, block: 0, text: 'let me ' });
  rec.ingest({ type: 'thinking_delta', seq: turnSeq, block: 0, text: 'think' });
  rec.ingest({ type: 'tool_use_start', seq: turnSeq, block: 1, tool: 'Read' });
  rec.ingest({ type: 'tool_use_done', seq: turnSeq, block: 1, input: { path: '/x' } });
  rec.ingest({ type: 'tool_result', seq: turnSeq, tool: 'Read', output: 'file contents' });
  rec.ingest({ type: 'text_delta', seq: turnSeq, text: 'The file ' });
  rec.ingest({ type: 'text_delta', seq: turnSeq, text: 'says hi' });
}

describe('createTurnLogRecorder — canonical turn normalization', () => {
  it('normalizes a full turn into 5 ordered records with exact refs/seqs/spanRef', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'user-1', sink });

    driveFullTurn(rec, 7);
    await rec.commitTurn(7);

    expect(callCount()).toBe(1); // one whole-turn batch
    const recs = batches[0] ?? [];
    expect(recs.map((r) => r.kind)).toEqual([
      'message',
      'thinking',
      'tool_call',
      'tool_result',
      'message',
    ]);
    expect(recs.map((r) => r.role)).toEqual(['human', 'agent', 'agent', 'tool', 'agent']);
    expect(recs.map((r) => r.seq)).toEqual([7000, 7001, 7002, 7003, 7004]);
    expect(recs.map((r) => r.producerRef)).toEqual([
      'gateway:s1:7:message:0',
      'gateway:s1:7:thinking:1',
      'gateway:s1:7:tool_call:2',
      'gateway:s1:7:tool_result:3',
      'gateway:s1:7:message:4',
    ]);
    expect(recs.every((r) => r.spanRef === 'gateway:s1:7')).toBe(true);
    expect(recs.every((r) => r.principal === 'user-1' && r.sessionId === 's1')).toBe(true);

    // Content is full-fidelity per kind.
    expect(recs[0]?.content).toBe('hello world');
    expect(recs[1]?.content).toBe('let me think'); // both deltas of the block
    expect(recs[2]?.content).toBe('{"path":"/x"}'); // tool_call content = JSON input
    expect(recs[2]?.toolName).toBe('Read');
    expect(recs[3]?.content).toBe('file contents'); // string output passthrough
    expect(recs[3]?.toolName).toBe('Read');
    expect(recs[4]?.content).toBe('The file says hi'); // agent message (last ordinal)

    expect(rec.stats()).toEqual({ committed: 5, dropped: 0, sinkErrors: 0 });
  });

  it('emits one thinking record per block, in block-arrival order', async () => {
    const { sink, batches } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    rec.ingest({ type: 'thinking_delta', seq: 3, block: 0, text: 'first' });
    rec.ingest({ type: 'thinking_delta', seq: 3, block: 1, text: 'second' });
    await rec.commitTurn(3);

    const recs = batches[0] ?? [];
    expect(recs.map((r) => r.kind)).toEqual(['thinking', 'thinking']);
    expect(recs.map((r) => r.content)).toEqual(['first', 'second']);
    expect(recs.map((r) => r.seq)).toEqual([3001, 3002]);
  });

  it('records a tool_use_done with no matching start as toolName "unknown" + one onError', async () => {
    const { sink, batches } = captureSink();
    const errors: string[] = [];
    const rec = createTurnLogRecorder({
      sessionId: 's1',
      principal: 'p',
      sink,
      onError: (m) => errors.push(m),
    });

    rec.ingest({ type: 'tool_use_done', seq: 2, block: 0, input: { a: 1 } });
    await rec.commitTurn(2);

    const recs = batches[0] ?? [];
    expect(recs).toHaveLength(1);
    expect(recs[0]?.kind).toBe('tool_call');
    expect(recs[0]?.toolName).toBe('unknown');
    expect(recs[0]?.content).toBe('{"a":1}');
    expect(errors).toHaveLength(1);
  });

  it('is fail-open: a throwing sink resolves, counts a sinkError, and clears state', async () => {
    const { sink, callCount } = throwingSink();
    const errors: string[] = [];
    const rec = createTurnLogRecorder({
      sessionId: 's1',
      principal: 'p',
      sink,
      onError: (m) => errors.push(m),
    });

    rec.ingest({ type: 'text_delta', seq: 1, text: 'hi' });
    await rec.commitTurn(1); // must NOT throw

    expect(rec.stats().sinkErrors).toBe(1);
    expect(errors).toHaveLength(1);
    expect(callCount()).toBe(1);

    // State was cleared on commit — re-committing the same seq sends nothing.
    await rec.commitTurn(1);
    expect(callCount()).toBe(1);
  });

  it('is deterministic: the same event sequence yields identical producerRefs/seqs', async () => {
    const a = captureSink();
    const recA = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink: a.sink });
    driveFullTurn(recA, 7);
    await recA.commitTurn(7);

    const b = captureSink();
    const recB = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink: b.sink });
    driveFullTurn(recB, 7);
    await recB.commitTurn(7);

    const refs = (batch: TurnLogRecord[]) =>
      batch.map((r) => ({ producerRef: r.producerRef, seq: r.seq }));
    expect(refs(a.batches[0] ?? [])).toEqual(refs(b.batches[0] ?? []));
    expect(JSON.stringify(a.batches)).toBe(JSON.stringify(b.batches));
  });

  it('caps records per turn: excess is dropped and counted', async () => {
    const { sink, batches } = captureSink();
    const rec = createTurnLogRecorder({
      sessionId: 's1',
      principal: 'p',
      sink,
      maxRecordsPerTurn: 3,
    });

    driveFullTurn(rec, 7); // would produce 5 records
    await rec.commitTurn(7);

    const recs = batches[0] ?? [];
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.kind)).toEqual(['message', 'thinking', 'tool_call']);
    expect(rec.stats().committed).toBe(3);
    expect(rec.stats().dropped).toBe(2);
  });

  it('abandon() drops accumulated turns — a later commit sends nothing', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    driveFullTurn(rec, 7);
    rec.abandon();
    await rec.commitTurn(7);

    expect(callCount()).toBe(0);
    expect(batches).toHaveLength(0);
  });

  it('does not call the sink for an empty turn (only an unknown event)', async () => {
    const { sink, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    rec.ingest({ type: 'turn_complete', seq: 1 }); // unknown → ignored, no content
    await rec.commitTurn(1);

    expect(callCount()).toBe(0);
  });
});
