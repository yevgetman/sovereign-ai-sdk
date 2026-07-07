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

/** A realistic AGENTIC turn: three assistant messages, each executing ONE tool
 *  on content-block index 1 — so `block` REPEATS (1,1,1) across the messages,
 *  exactly as the gateway emits it (block is intra-message, not intra-turn).
 *  Per-event monotonic seqs (80..90), all distinct from the turn's seq. */
function driveAgenticTurn(rec: TurnLogRecorder, turnSeq: number): void {
  // Assistant message 1: a thought, then a WebFetch on block 1.
  rec.ingest({ type: 'thinking_delta', seq: 80, block: 0, text: 'planning' });
  rec.ingest({ type: 'tool_use_start', seq: 81, block: 1, tool: 'WebFetch' });
  rec.ingest({ type: 'tool_use_done', seq: 82, block: 1, input: { url: 'x' } });
  rec.ingest({ type: 'tool_result', seq: 83, tool: 'WebFetch', output: 'fetched' });
  // Assistant message 2: a Bash on block 1 AGAIN (block index repeats).
  rec.ingest({ type: 'tool_use_start', seq: 84, block: 1, tool: 'Bash' });
  rec.ingest({ type: 'tool_use_done', seq: 85, block: 1, input: { command: 'resume --help' } });
  rec.ingest({ type: 'tool_result', seq: 86, tool: 'Bash', output: 'usage...' });
  // Assistant message 3: a FileEdit on block 1 AGAIN.
  rec.ingest({ type: 'tool_use_start', seq: 87, block: 1, tool: 'FileEdit' });
  rec.ingest({ type: 'tool_use_done', seq: 88, block: 1, input: { path: 'a' } });
  rec.ingest({ type: 'tool_result', seq: 89, tool: 'FileEdit', output: 'edited' });
  // Final agent text, then seal + human text.
  rec.ingest({ type: 'text_delta', seq: 90, text: 'All done' });
  rec.ingest({ type: 'turn_complete', seq: turnSeq });
  rec.setHumanText(turnSeq, 'do a bunch of things');
}

/** A TWO-PHASE agentic turn: reason → act → reason → act. Each reasoning phase
 *  streams thinking on block 0 (the block index REPEATS across assistant
 *  messages). The FIRST non-thinking content event of each phase FINALIZES the
 *  open thinking, so phase two's `thinking_delta` (block 0 AGAIN) starts a NEW
 *  unit at a NEW ordinal — one thinking row per reasoning phase, interleaved
 *  between the actions each phase motivated. Per-event monotonic seqs (40..49). */
function driveTwoPhaseTurn(rec: TurnLogRecorder, turnSeq: number): void {
  // Phase one: reason (two deltas, same block), then a Bash execution.
  rec.ingest({ type: 'thinking_delta', seq: 40, block: 0, text: 'phase one ' });
  rec.ingest({ type: 'thinking_delta', seq: 41, block: 0, text: 'phase one ' });
  rec.ingest({ type: 'tool_use_start', seq: 42, block: 1, tool: 'Bash' });
  rec.ingest({ type: 'tool_use_done', seq: 43, block: 1, input: { command: 'a' } });
  rec.ingest({ type: 'tool_result', seq: 44, block: 1, tool: 'Bash', output: 'ran a' });
  // Phase two: reason AGAIN (block 0 reused), then a FileEdit execution.
  rec.ingest({ type: 'thinking_delta', seq: 45, block: 0, text: 'phase two' });
  rec.ingest({ type: 'tool_use_start', seq: 46, block: 1, tool: 'FileEdit' });
  rec.ingest({ type: 'tool_use_done', seq: 47, block: 1, input: { path: 'b' } });
  rec.ingest({ type: 'tool_result', seq: 48, block: 1, tool: 'FileEdit', output: 'edited b' });
  // Final agent text, then seal + human text.
  rec.ingest({ type: 'text_delta', seq: 49, text: 'both phases done' });
  rec.ingest({ type: 'turn_complete', seq: turnSeq });
  rec.setHumanText(turnSeq, 'reason, act, reason, act');
}

describe('createTurnLogRecorder — open-turn accumulation over the real wire', () => {
  it('records ONE tool_call per execution when block indexes repeat across assistant messages', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'user-1', sink });

    driveAgenticTurn(rec, 200); // three tool executions, all on block 1
    await rec.commitTurn(200);

    expect(callCount()).toBe(1);
    const recs = batches[0] ?? [];

    // Exactly THREE tool_call records — one per execution, NOT one collapsed unit.
    const calls = recs.filter((r) => r.kind === 'tool_call');
    const results = recs.filter((r) => r.kind === 'tool_result');
    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(3);

    // Verbatim per-execution toolName + JSON input, in execution order.
    expect(calls.map((r) => r.toolName)).toEqual(['WebFetch', 'Bash', 'FileEdit']);
    expect(calls.map((r) => r.content)).toEqual([
      '{"url":"x"}',
      '{"command":"resume --help"}',
      '{"path":"a"}',
    ]);

    // Chronologically interleaved: each call's ordinal precedes its OWN result's.
    for (const tool of ['WebFetch', 'Bash', 'FileEdit']) {
      const call = calls.find((r) => r.toolName === tool);
      const result = results.find((r) => r.toolName === tool);
      expect(call).toBeDefined();
      expect(result).toBeDefined();
      expect((call as TurnLogRecord).seq).toBeLessThan((result as TurnLogRecord).seq);
    }

    // Total 9 records: human, thinking, 3×(call+result), agent — exact seq math.
    expect(recs).toHaveLength(9);
    expect(recs.map((r) => r.kind)).toEqual([
      'message',
      'thinking',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'message',
    ]);
    expect(recs.map((r) => r.role)).toEqual([
      'human',
      'agent',
      'agent',
      'tool',
      'agent',
      'tool',
      'agent',
      'tool',
      'agent',
    ]);
    expect(recs.map((r) => r.seq)).toEqual([
      200000, 200001, 200002, 200003, 200004, 200005, 200006, 200007, 200008,
    ]);

    // Distinct producerRefs — no two records collide on the idempotency key.
    const refs = recs.map((r) => r.producerRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toEqual([
      'gateway:s1:200:message:0',
      'gateway:s1:200:thinking:1',
      'gateway:s1:200:tool_call:2',
      'gateway:s1:200:tool_result:3',
      'gateway:s1:200:tool_call:4',
      'gateway:s1:200:tool_result:5',
      'gateway:s1:200:tool_call:6',
      'gateway:s1:200:tool_result:7',
      'gateway:s1:200:message:8',
    ]);

    expect(rec.stats()).toEqual({ committed: 9, dropped: 0, sinkErrors: 0 });
  });

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

  it('finalizes thinking at phase boundaries: one thinking row per reasoning phase, interleaved', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'user-1', sink });

    driveTwoPhaseTurn(rec, 300); // reason → act → reason → act
    await rec.commitTurn(300);

    expect(callCount()).toBe(1);
    const recs = batches[0] ?? [];

    // TWO thinking rows — one per reasoning phase, NOT one merged unit at the
    // first thinking ordinal. Each is the EXACT accumulation of its own deltas.
    const thinking = recs.filter((r) => r.kind === 'thinking');
    expect(thinking).toHaveLength(2);
    expect(thinking.map((r) => r.content)).toEqual(['phase one phase one ', 'phase two']);

    const calls = recs.filter((r) => r.kind === 'tool_call');
    const results = recs.filter((r) => r.kind === 'tool_result');
    // Each phase's thinking ordinal PRECEDES that phase's tool_call.
    expect((thinking[0] as TurnLogRecord).seq).toBeLessThan((calls[0] as TurnLogRecord).seq);
    expect((thinking[1] as TurnLogRecord).seq).toBeLessThan((calls[1] as TurnLogRecord).seq);
    // TRUE interleaving: phase two's thinking comes AFTER phase one's tool_result
    // — later reasoning no longer appears (misleadingly) early.
    expect((thinking[1] as TurnLogRecord).seq).toBeGreaterThan((results[0] as TurnLogRecord).seq);

    // Exact structure + seq math: 8 records, ordinals 0..7, thinking interleaved.
    expect(recs.map((r) => r.kind)).toEqual([
      'message',
      'thinking',
      'tool_call',
      'tool_result',
      'thinking',
      'tool_call',
      'tool_result',
      'message',
    ]);
    expect(recs.map((r) => r.seq)).toEqual([
      300000, 300001, 300002, 300003, 300004, 300005, 300006, 300007,
    ]);
    expect(recs.map((r) => r.content)).toEqual([
      'reason, act, reason, act',
      'phase one phase one ',
      '{"command":"a"}',
      'ran a',
      'phase two',
      '{"path":"b"}',
      'edited b',
      'both phases done',
    ]);

    // Distinct producerRefs — the two thinking rows get DISTINCT ordinals (1, 4),
    // so neither collides on the idempotency key.
    const refs = recs.map((r) => r.producerRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(thinking.map((r) => r.producerRef)).toEqual([
      'gateway:s1:300:thinking:1',
      'gateway:s1:300:thinking:4',
    ]);

    expect(rec.stats()).toEqual({ committed: 8, dropped: 0, sinkErrors: 0 });
  });

  it('flushOpen: seals + flushes an OPEN (never-completed) turn, marking every record incomplete', async () => {
    const { sink, batches, callCount } = captureSink();
    const sourceTag = { harness: 'gateway', env: 'staging' };
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'user-1', sink, sourceTag });

    // A partial turn: human + thinking + one tool execution, then the stream
    // stalls — NO turn_complete, NO agent text.
    rec.setHumanText(500, 'why is my build failing?'); // no sealed slot → the open accumulation
    rec.ingest({ type: 'thinking_delta', seq: 91, block: 0, text: 'let me look' });
    rec.ingest({ type: 'tool_use_start', seq: 93, block: 1, tool: 'Read' });
    rec.ingest({ type: 'tool_use_done', seq: 95, block: 1, input: { path: '/x' } });
    rec.ingest({ type: 'tool_result', seq: 97, tool: 'Read', output: 'file contents' });

    await rec.flushOpen(500, 'stalled');

    expect(callCount()).toBe(1);
    const recs = batches[0] ?? [];

    // Same shape/ordering/seq-math as a committed turn (no agent message — empty).
    expect(recs.map((r) => r.kind)).toEqual(['message', 'thinking', 'tool_call', 'tool_result']);
    expect(recs.map((r) => r.role)).toEqual(['human', 'agent', 'agent', 'tool']);
    expect(recs.map((r) => r.seq)).toEqual([500000, 500001, 500002, 500003]);
    expect(recs.map((r) => r.producerRef)).toEqual([
      'gateway:s1:500:message:0',
      'gateway:s1:500:thinking:1',
      'gateway:s1:500:tool_call:2',
      'gateway:s1:500:tool_result:3',
    ]);
    expect(recs.map((r) => r.content)).toEqual([
      'why is my build failing?',
      'let me look',
      '{"path":"/x"}',
      'file contents',
    ]);

    // Every record's source merges the configured sourceTag with the incomplete marker.
    for (const r of recs) {
      expect(r.source).toEqual({
        harness: 'gateway',
        env: 'staging',
        incomplete: true,
        reason: 'stalled',
      });
    }

    expect(rec.stats()).toEqual({ committed: 4, dropped: 0, sinkErrors: 0 });
  });

  it('flushOpen: is a no-op when the open accumulation has nothing committable', async () => {
    const { sink, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    await rec.flushOpen(1, 'stalled'); // nothing ingested
    expect(callCount()).toBe(0);
    expect(rec.stats()).toEqual({ committed: 0, dropped: 0, sinkErrors: 0 });
  });

  it('flushOpen: clears the open accumulation — a second flushOpen sends nothing', async () => {
    const { sink, batches, callCount } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    rec.ingest({ type: 'text_delta', seq: 10, text: 'partial reply' });
    await rec.flushOpen(600, 'stalled');
    expect(callCount()).toBe(1);
    expect((batches[0] ?? [])[0]?.content).toBe('partial reply');

    // State cleared: a second flush (no fresh events) is a no-op — no re-emit.
    await rec.flushOpen(600, 'stalled');
    expect(callCount()).toBe(1);
  });

  it('flushOpen: is fail-open — a throwing sink resolves, counts a sinkError, and clears state', async () => {
    const { sink, callCount } = throwingSink();
    const errors: string[] = [];
    const rec = createTurnLogRecorder({
      sessionId: 's1',
      principal: 'p',
      sink,
      onError: (m) => errors.push(m),
    });

    rec.ingest({ type: 'text_delta', seq: 10, text: 'partial' });
    await rec.flushOpen(700, 'errored'); // must NOT throw

    expect(rec.stats().sinkErrors).toBe(1);
    expect(errors).toHaveLength(1);
    expect(callCount()).toBe(1);
    // State was cleared before the sink call — a re-flush sends nothing.
    await rec.flushOpen(700, 'errored');
    expect(callCount()).toBe(1);
  });

  it('flushOpen: does not disturb the normal commit path — a completed turn is never marked incomplete', async () => {
    const { sink, batches, callCount } = captureSink();
    const sourceTag = { harness: 'gateway', env: 'staging' };
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink, sourceTag });

    driveFullTurn(rec, 101); // a normal, COMPLETED turn (turn_complete seals it)
    await rec.commitTurn(101);

    expect(callCount()).toBe(1);
    const recs = batches[0] ?? [];
    expect(recs).toHaveLength(5);
    // A completed turn carries the plain sourceTag — no incomplete marker.
    for (const r of recs) {
      expect(r.source).toEqual({ harness: 'gateway', env: 'staging' });
    }
    expect(rec.stats()).toEqual({ committed: 5, dropped: 0, sinkErrors: 0 });
  });

  it('finalizes multi-block thinking within one phase at the boundary; a later thought is a NEW unit', async () => {
    const { sink, batches } = captureSink();
    const rec = createTurnLogRecorder({ sessionId: 's1', principal: 'p', sink });

    // One reasoning phase, TWO thinking blocks streaming before any tool event.
    rec.ingest({ type: 'thinking_delta', seq: 60, block: 0, text: 'block zero' });
    rec.ingest({ type: 'thinking_delta', seq: 61, block: 1, text: 'block one' });
    // Boundary: a tool execution FINALIZES BOTH open thinking blocks at once.
    rec.ingest({ type: 'tool_use_start', seq: 62, block: 2, tool: 'Read' });
    rec.ingest({ type: 'tool_use_done', seq: 63, block: 2, input: { path: '/z' } });
    // A later thought reuses block 0 — must be a NEW unit, not a merge into block 0.
    rec.ingest({ type: 'thinking_delta', seq: 64, block: 0, text: 'after the tool' });
    rec.ingest({ type: 'turn_complete', seq: 65 });
    await rec.commitTurn(65);

    const recs = batches[0] ?? [];
    expect(recs.map((r) => r.kind)).toEqual(['thinking', 'thinking', 'tool_call', 'thinking']);
    expect(recs.map((r) => r.content)).toEqual([
      'block zero',
      'block one',
      '{"path":"/z"}',
      'after the tool',
    ]);
    // Three distinct thinking ordinals: 1 and 2 (both finalized at the boundary),
    // then 4 (the post-tool thought) — ordinal 3 is the tool_call between them.
    expect(recs.filter((r) => r.kind === 'thinking').map((r) => r.seq)).toEqual([
      65001, 65002, 65004,
    ]);
  });
});
