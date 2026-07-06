// Durable turn logging (spec 2026-07-06) — the `createTurnLogRecorder`
// normalizer, exercised over the REAL sov gateway wire. On the wire `seq` is a
// per-EVENT monotonic counter (text_delta seq=99, tool_use_done seq=95, …),
// NOT a per-turn value — only the terminal `turn_complete` carries the turn's
// seq. So the recorder accumulates every content event since the last
// `turn_complete` into a single OPEN slot ("everything since the last
// turn_complete belongs to that turn"; the gateway is single-threaded per
// session); `turn_complete` SEALS that slot under its seq; `commitTurn(seq)`
// flushes only the sealed slot. Covers:
//   • full-turn normalization: human + thinking(×2 same block) + tool call +
//     tool result + agent message → 5 records with the exact kinds / roles /
//     seqs / producerRefs / spanRef the platform consumes — where the content
//     events carry per-event seqs entirely distinct from the turn's seq;
//   • multi-block thinking (block-arrival ordinal order);
//   • a tool_use_done with no matching start (toolName 'unknown' + onError);
//   • fail-open sink: a throwing sink resolves, counts a sinkError, clears state;
//   • determinism (replay yields byte-identical producerRefs/seqs — the sink
//     dedupes on producerRef);
//   • the per-turn ordinal cap (excess dropped + counted);
//   • abandon() (drops open + sealed state);
//   • an empty turn (turn_complete with no content → the sink is never called);
//   • the REPLAY scenario: a historical replay streams many uncommitted
//     turn_completes; committing only the live seq yields exactly the live
//     turn's records with zero historical leakage;
//   • the sealed-slot cap (drop-oldest, counted in stats.dropped);
//   • setHumanText BEFORE turn_complete (applies to the open accumulation).
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

/** The canonical full turn on the REAL wire: two thinking deltas on ONE block, a
 *  matched tool call, a tool result, and two agent text deltas — each content
 *  event carrying its OWN per-event monotonic seq (91..100), all distinct from
 *  the turn's seq. `turn_complete` carries the turn's seq LAST and SEALS the
 *  slot; the platform sets the human text AFTER the seal (the live path). */
function driveFullTurn(rec: TurnLogRecorder, turnSeq: number): void {
  rec.ingest({ type: 'thinking_delta', seq: 91, block: 0, text: 'let me ' });
  rec.ingest({ type: 'thinking_delta', seq: 92, block: 0, text: 'think' });
  rec.ingest({ type: 'tool_use_start', seq: 93, block: 1, tool: 'Read' });
  rec.ingest({ type: 'tool_use_done', seq: 95, block: 1, input: { path: '/x' } });
  rec.ingest({ type: 'tool_result', seq: 97, tool: 'Read', output: 'file contents' });
  rec.ingest({ type: 'text_delta', seq: 99, text: 'The file ' });
  rec.ingest({ type: 'text_delta', seq: 100, text: 'says hi' });
  rec.ingest({ type: 'turn_complete', seq: turnSeq });
  rec.setHumanText(turnSeq, 'hello world');
}

describe('createTurnLogRecorder — open-turn accumulation over the real wire', () => {
  it('normalizes a full turn into 5 ordered records though content seqs differ from the turn seq', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'user-1', sink });

    driveFullTurn(rec, 101); // content events at seqs 91..100; turn seq = 101
    await rec.commitTurn(101);

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
    // Every record is keyed to the TURN's seq (101), not the per-event seqs.
    expect(recs.map((r) => r.seq)).toEqual([101000, 101001, 101002, 101003, 101004]);
    expect(recs.map((r) => r.producerRef)).toEqual([
      'gateway:s1:101:message:0',
      'gateway:s1:101:thinking:1',
      'gateway:s1:101:tool_call:2',
      'gateway:s1:101:tool_result:3',
      'gateway:s1:101:message:4',
    ]);
    expect(recs.every((r) => r.spanRef === 'gateway:s1:101')).toBe(true);
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

    rec.ingest({ type: 'thinking_delta', seq: 71, block: 0, text: 'first' });
    rec.ingest({ type: 'thinking_delta', seq: 72, block: 1, text: 'second' });
    rec.ingest({ type: 'turn_complete', seq: 73 }); // seals under the turn seq
    await rec.commitTurn(73);

    const recs = batches[0] ?? [];
    expect(recs.map((r) => r.kind)).toEqual(['thinking', 'thinking']);
    expect(recs.map((r) => r.content)).toEqual(['first', 'second']);
    expect(recs.map((r) => r.seq)).toEqual([73001, 73002]);
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

    rec.ingest({ type: 'tool_use_done', seq: 55, block: 0, input: { a: 1 } });
    rec.ingest({ type: 'turn_complete', seq: 56 });
    await rec.commitTurn(56);

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

    rec.ingest({ type: 'text_delta', seq: 10, text: 'hi' });
    rec.ingest({ type: 'turn_complete', seq: 11 });
    await rec.commitTurn(11); // must NOT throw

    expect(rec.stats().sinkErrors).toBe(1);
    expect(errors).toHaveLength(1);
    expect(callCount()).toBe(1);

    // The sealed slot was cleared on commit — re-committing the same seq sends nothing.
    await rec.commitTurn(11);
    expect(callCount()).toBe(1);
  });

  it('is deterministic: the same event sequence yields identical producerRefs/seqs', async () => {
    const a = captureSink();
    const recA = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink: a.sink });
    driveFullTurn(recA, 101);
    await recA.commitTurn(101);

    const b = captureSink();
    const recB = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink: b.sink });
    driveFullTurn(recB, 101);
    await recB.commitTurn(101);

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

    driveFullTurn(rec, 101); // would produce 5 records
    await rec.commitTurn(101);

    const recs = batches[0] ?? [];
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.kind)).toEqual(['message', 'thinking', 'tool_call']);
    expect(rec.stats().committed).toBe(3);
    expect(rec.stats().dropped).toBe(2);
  });

  it('abandon() drops open + sealed state — a later commit sends nothing', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    driveFullTurn(rec, 101); // seals slot 101
    rec.abandon();
    await rec.commitTurn(101);

    expect(callCount()).toBe(0);
    expect(batches).toHaveLength(0);
  });

  it('does not call the sink for an empty turn (unknown event, then an empty turn_complete)', async () => {
    const { sink, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    rec.ingest({ type: 'some_unknown_event', seq: 1 }); // unknown → ignored
    rec.ingest({ type: 'turn_complete', seq: 9 }); // seals an empty slot
    await rec.commitTurn(9);

    expect(callCount()).toBe(0);
  });

  it('replay: uncommitted historical turns seal-and-roll; only the live seq commits — zero leakage', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    // A historical replay streams two prior turns (content + terminal
    // turn_complete each). The follower NEVER commits these — their sealed slots
    // are dead weight until evicted. Each turn_complete seals the open slot and
    // rolls a fresh one, so no historical content bleeds into the next turn.
    rec.ingest({ type: 'text_delta', seq: 1, text: 'HISTORICAL reply one' });
    rec.ingest({ type: 'turn_complete', seq: 2 });
    rec.ingest({ type: 'thinking_delta', seq: 3, block: 0, text: 'HISTORICAL thinking' });
    rec.ingest({ type: 'text_delta', seq: 4, text: 'HISTORICAL reply two' });
    rec.ingest({ type: 'turn_complete', seq: 5 });

    // The LIVE turn (the first created:true turn the follower will commit).
    driveFullTurn(rec, 101);

    // The follower commits ONLY the live seq.
    await rec.commitTurn(101);

    expect(callCount()).toBe(1);
    const recs = batches[0] ?? [];
    expect(recs).toHaveLength(5);
    expect(recs.map((r) => r.kind)).toEqual([
      'message',
      'thinking',
      'tool_call',
      'tool_result',
      'message',
    ]);
    expect(recs.map((r) => r.content)).toEqual([
      'hello world',
      'let me think',
      '{"path":"/x"}',
      'file contents',
      'The file says hi',
    ]);
    // Zero historical leakage into the live turn's records.
    expect(recs.some((r) => (r.content ?? '').includes('HISTORICAL'))).toBe(false);
    expect(recs.every((r) => r.seq >= 101000 && r.seq <= 101004)).toBe(true);

    // The historical slots were never flushed to the sink.
    expect(rec.stats().committed).toBe(5);
  });

  it('caps sealed slots at 4 (drop-oldest), counting evictions in stats.dropped', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    // Seal SIX turns; only the last four slots survive (drop-oldest).
    for (const seq of [10, 20, 30, 40, 50, 60]) {
      rec.ingest({ type: 'text_delta', seq: seq - 1, text: `reply ${seq}` });
      rec.ingest({ type: 'turn_complete', seq });
    }

    // The two oldest slots (10, 20) were evicted → counted in stats.dropped.
    expect(rec.stats().dropped).toBe(2);

    // Committing an evicted seq is silent (replay-safe: no sink call).
    await rec.commitTurn(10);
    await rec.commitTurn(20);
    expect(callCount()).toBe(0);

    // A surviving seq still commits its content.
    await rec.commitTurn(30);
    expect(callCount()).toBe(1);
    expect((batches[0] ?? [])[0]?.content).toBe('reply 30');
  });

  it('setHumanText before turn_complete applies to the open accumulation, then seals with it', async () => {
    const { sink, batches } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    rec.setHumanText(77, 'human first'); // no sealed slot yet → the open accumulation
    rec.ingest({ type: 'text_delta', seq: 70, text: 'agent reply' });
    rec.ingest({ type: 'turn_complete', seq: 77 }); // seals the open slot, carrying the human text
    await rec.commitTurn(77);

    const recs = batches[0] ?? [];
    expect(recs.map((r) => r.kind)).toEqual(['message', 'message']);
    expect(recs.map((r) => r.role)).toEqual(['human', 'agent']);
    expect(recs.map((r) => r.content)).toEqual(['human first', 'agent reply']);
    expect(recs.map((r) => r.seq)).toEqual([77000, 77001]);
  });
});
