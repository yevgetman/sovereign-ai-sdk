import { describe, expect, it } from 'bun:test';
// Spec 2026-07-05 (assay integration) — the Assay usage recorder. Covers:
//   • the event→span state machine: pending chat spans seal at the NEXT
//     provider_response / turn_start / session_end / flush; dominant-tool
//     attribution (tool_error counts — the tool was invoked); turn defaults to
//     0 before any turn_start; a new session_start seals + flushes prior state;
//   • deterministic ids (replay-idempotent producer_refs on the assay side);
//   • transport: batch trigger, retry-once-then-drop, bounded drop-oldest
//     queue, auth header + redirect:'error', record() never throws;
//   • S5 golden emission: the scripted session serializes BYTE-IDENTICALLY to
//     fixtures/assay-wire-v1.json (the cross-repo conformance artifact).
//     Regen: delete the fixture and rerun — the test writes a missing file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssayUsageRecorder, dominantTool } from '../src/telemetry/assayUsageRecorder.js';
import type { TraceEvent } from '../src/trace/types.js';

const FIXTURE_PATH = join(import.meta.dir, '../../../fixtures/assay-wire-v1.json');

type CapturedPost = { url: string; init: RequestInit };

/** A scripted fetch capturing every POST; per-call status via `statuses`. */
function fakeFetch(statuses: number[] = []) {
  const posts: CapturedPost[] = [];
  let call = 0;
  const impl = (async (url: unknown, init?: RequestInit) => {
    posts.push({ url: String(url), init: init ?? {} });
    const status = statuses[call] ?? 200;
    call += 1;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { impl, posts };
}

const ISO = (s: string): string => `2026-07-05T12:00:${s}Z`;

/** The S5 scripted session — 2 turns: 2 calls + Read/Edit/Edit(err) tools, then
 *  1 call with no tools. Fixed times ⇒ a fully deterministic wire body. */
function scriptedSession(): TraceEvent[] {
  return [
    {
      type: 'session_start',
      sessionId: 'sov-fixture-session-1',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      cwd: '/tmp/fixture',
      iso: ISO('00.000'),
    },
    { type: 'turn_start', turn: 1, iso: ISO('00.100') },
    {
      type: 'provider_response',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      purpose: 'main',
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 8000,
        cacheCreationInputTokens: 150,
      },
      latencyMs: 1500,
      stopReason: 'tool_use',
      iso: ISO('02.000'),
    },
    { type: 'tool_start', tool: 'Read', toolUseId: 'tu-1', iso: ISO('02.050') },
    {
      type: 'tool_end',
      tool: 'Read',
      toolUseId: 'tu-1',
      durationMs: 40,
      outputBytes: 2048,
      iso: ISO('02.100'),
    },
    { type: 'tool_start', tool: 'Edit', toolUseId: 'tu-2', iso: ISO('02.200') },
    {
      type: 'tool_end',
      tool: 'Edit',
      toolUseId: 'tu-2',
      durationMs: 60,
      outputBytes: 512,
      iso: ISO('02.300'),
    },
    { type: 'tool_start', tool: 'Edit', toolUseId: 'tu-3', iso: ISO('02.350') },
    {
      type: 'tool_error',
      tool: 'Edit',
      toolUseId: 'tu-3',
      durationMs: 25,
      message: 'file not found',
      iso: ISO('02.400'),
    },
    {
      type: 'provider_response',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      purpose: 'main',
      usage: { inputTokens: 1400, outputTokens: 250, cacheReadInputTokens: 9000 },
      latencyMs: 1200,
      stopReason: 'end_turn',
      iso: ISO('05.000'),
    },
    { type: 'turn_start', turn: 2, iso: ISO('10.000') },
    {
      type: 'provider_response',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      purpose: 'main',
      usage: { inputTokens: 500, outputTokens: 400, reasoningTokens: 120 },
      latencyMs: 900,
      stopReason: 'end_turn',
      iso: ISO('12.000'),
    },
    { type: 'session_end', reason: 'completed', iso: ISO('13.000') },
  ];
}

type WireSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value: Record<string, string> }>;
};
type WireBody = { resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }> };

const spansOf = (body: WireBody): WireSpan[] => body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
const attr = (s: WireSpan, key: string): string | undefined => {
  const a = s.attributes.find((x) => x.key === key);
  return a === undefined ? undefined : (a.value.stringValue ?? a.value.intValue);
};

async function runScripted(statuses: number[] = []): Promise<{ posts: CapturedPost[] }> {
  const { impl, posts } = fakeFetch(statuses);
  const rec = createAssayUsageRecorder({ token: 'tkn', fetch: impl, batchSize: 1000 });
  for (const e of scriptedSession()) rec.record(e);
  await rec.flush();
  return { posts };
}

describe('dominantTool', () => {
  it('most frequent wins; ties break to the first tied tool', () => {
    expect(dominantTool(['Read', 'Edit', 'Edit'])).toBe('Edit');
    expect(dominantTool(['Read', 'Edit'])).toBe('Read');
    expect(dominantTool([])).toBeUndefined();
  });
});

describe('the event → span state machine', () => {
  it('emits 3 chat + 3 tool spans for the scripted session, with correct attribution', async () => {
    const { posts } = await runScripted();
    expect(posts).toHaveLength(1); // session_end drained everything in one batch
    const body = JSON.parse(String(posts[0]?.init.body)) as WireBody;
    const spans = spansOf(body);
    expect(spans).toHaveLength(6);

    const chats = spans.filter((s) => attr(s, 'gen_ai.operation.name') === 'chat');
    const tools = spans.filter((s) => attr(s, 'gen_ai.operation.name') === 'execute_tool');
    expect(chats).toHaveLength(3);
    expect(tools).toHaveLength(3);

    // Chat #1: dominant tool Edit (Read, Edit, Edit — the ERRORED Edit counts).
    const c1 = chats[0] as WireSpan;
    expect(attr(c1, 'gen_ai.tool.name')).toBe('Edit');
    expect(attr(c1, 'gen_ai.usage.input_tokens')).toBe('1200');
    expect(attr(c1, 'gen_ai.usage.cache_read_tokens')).toBe('8000');
    expect(attr(c1, 'gen_ai.usage.reasoning_tokens')).toBeUndefined(); // absent field omitted
    expect(attr(c1, 'sov.turn.id')).toBe('sov-fixture-session-1#1');
    expect(c1.parentSpanId).toBeUndefined(); // the turn's root

    // Chat #2: same turn — parented to the turn root, NO tool (none followed it).
    const c2 = chats[1] as WireSpan;
    expect(c2.parentSpanId).toBe(c1.spanId);
    expect(attr(c2, 'gen_ai.tool.name')).toBeUndefined();
    expect(c2.traceId).toBe(c1.traceId); // one trace per turn

    // Chat #3: turn 2 — a NEW trace, a new root, reasoning carried.
    const c3 = chats[2] as WireSpan;
    expect(c3.traceId).not.toBe(c1.traceId);
    expect(c3.parentSpanId).toBeUndefined();
    expect(attr(c3, 'sov.turn.id')).toBe('sov-fixture-session-1#2');
    expect(attr(c3, 'gen_ai.usage.reasoning_tokens')).toBe('120');

    // Tool spans: parented to the chat span that requested them; error carried.
    for (const t of tools) expect(t.parentSpanId).toBe(c1.spanId);
    expect(attr(tools[2] as WireSpan, 'sov.error')).toBe('file not found');
    // Every span carries the wire version + identity.
    for (const s of spans) {
      expect(attr(s, 'sov.telemetry.version')).toBe('1');
      expect(attr(s, 'gen_ai.agent.id')).toBe('sov');
      expect(attr(s, 'gen_ai.conversation.id')).toBe('sov-fixture-session-1');
    }
  });

  it('ids are deterministic — the same script yields byte-identical bodies (replay dedupes)', async () => {
    const a = await runScripted();
    const b = await runScripted();
    expect(String(a.posts[0]?.init.body)).toBe(String(b.posts[0]?.init.body));
  });

  it('emitToolSpans:false suppresses tool spans but keeps chat attribution', async () => {
    const { impl, posts } = fakeFetch();
    const rec = createAssayUsageRecorder({
      token: 'tkn',
      fetch: impl,
      emitToolSpans: false,
      batchSize: 1000,
    });
    for (const e of scriptedSession()) rec.record(e);
    await rec.flush();
    const spans = spansOf(JSON.parse(String(posts[0]?.init.body)) as WireBody);
    expect(spans).toHaveLength(3); // chat spans only
    expect(attr(spans[0] as WireSpan, 'gen_ai.tool.name')).toBe('Edit'); // attribution survives
  });

  it('turn defaults to 0 before any turn_start; flush() seals a pending span', async () => {
    const { impl, posts } = fakeFetch();
    const rec = createAssayUsageRecorder({ token: 'tkn', fetch: impl, batchSize: 1000 });
    rec.record({
      type: 'provider_response',
      provider: 'anthropic',
      model: 'm',
      purpose: 'main',
      usage: { inputTokens: 10 },
      latencyMs: 100,
      stopReason: 'end_turn',
      iso: ISO('01.000'),
    });
    await rec.flush(); // flush is a seal boundary
    const spans = spansOf(JSON.parse(String(posts[0]?.init.body)) as WireBody);
    expect(spans).toHaveLength(1);
    expect(attr(spans[0] as WireSpan, 'sov.turn.id')).toMatch(/#0$/); // default turn 0
  });

  it('a NEW session_start seals prior pending state (session-affinity defense)', async () => {
    const { impl, posts } = fakeFetch();
    const rec = createAssayUsageRecorder({ token: 'tkn', fetch: impl, batchSize: 1000 });
    rec.record(scriptedSession()[0] as TraceEvent); // session 1
    rec.record({
      type: 'provider_response',
      provider: 'anthropic',
      model: 'm',
      purpose: 'main',
      usage: { inputTokens: 5 },
      latencyMs: 50,
      stopReason: 'end_turn',
      iso: ISO('01.000'),
    });
    rec.record({
      type: 'session_start',
      sessionId: 'session-2',
      provider: 'anthropic',
      model: 'm',
      cwd: '/',
      iso: ISO('02.000'),
    });
    await rec.flush();
    const all = posts.flatMap((p) => spansOf(JSON.parse(String(p.init.body)) as WireBody));
    expect(all).toHaveLength(1); // the pending span of session 1 was sealed, not lost
    expect(attr(all[0] as WireSpan, 'gen_ai.conversation.id')).toBe('sov-fixture-session-1');
  });

  it('server wiring: sequential user turns whose loop counter resets to 0 still get DISTINCT ids + the real session', async () => {
    // Reproduces the real gateway stream: query() restarts its per-invocation
    // loop counter at 0 on EVERY user turn, and the turns route forwards a
    // session_start (the real session id) at the top of each turn. Before the fix
    // both turns collided on sov.turn.id=<randomUUID>#0; after it they are
    // distinct and carry the real conversation id.
    const { impl, posts } = fakeFetch();
    const rec = createAssayUsageRecorder({ token: 'tkn', fetch: impl, batchSize: 1000 });
    const seed = (): TraceEvent => ({
      type: 'session_start',
      sessionId: 'real-gateway-session',
      provider: 'anthropic',
      model: 'm',
      cwd: '/',
      iso: ISO('00.000'),
    });
    const turn0 = (): TraceEvent => ({ type: 'turn_start', turn: 0, iso: ISO('00.100') }); // query is ALWAYS 0
    const resp = (n: number): TraceEvent => ({
      type: 'provider_response',
      provider: 'anthropic',
      model: 'm',
      purpose: 'main',
      usage: { inputTokens: n },
      latencyMs: 1,
      stopReason: 'end_turn',
      iso: ISO(`0${n}.000`),
    });
    // user turn 1, then user turn 2 — each a fresh query() (turn resets to 0).
    rec.record(seed());
    rec.record(turn0());
    rec.record(resp(1));
    rec.record(seed());
    rec.record(turn0());
    rec.record(resp(2));
    await rec.flush();
    const chats = posts
      .flatMap((p) => spansOf(JSON.parse(String(p.init.body)) as WireBody))
      .filter((s) => attr(s, 'gen_ai.operation.name') === 'chat');
    expect(chats).toHaveLength(2);
    // The real session id, not the boot-time random UUID.
    for (const s of chats) expect(attr(s, 'gen_ai.conversation.id')).toBe('real-gateway-session');
    // Distinct turn ids + traces despite query sending turn=0 both times.
    expect(attr(chats[0] as WireSpan, 'sov.turn.id')).not.toBe(
      attr(chats[1] as WireSpan, 'sov.turn.id'),
    );
    expect((chats[0] as WireSpan).traceId).not.toBe((chats[1] as WireSpan).traceId);
  });
});

describe('transport', () => {
  it('sends with the bearer token and redirect:error', async () => {
    const { posts } = await runScripted();
    const init = posts[0]?.init as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tkn');
    expect(init.redirect).toBe('error');
    expect(posts[0]?.url).toBe('http://127.0.0.1:4318/v1/traces');
  });

  it('a failed batch retries ONCE, then drops (counted, never thrown)', async () => {
    const { impl, posts } = fakeFetch([500, 500]);
    const rec = createAssayUsageRecorder({ token: 'tkn', fetch: impl, batchSize: 1000 });
    for (const e of scriptedSession()) rec.record(e);
    await rec.flush();
    expect(posts).toHaveLength(2); // first attempt + one retry
    const s = rec.stats();
    expect(s.failed).toBe(2);
    expect(s.dropped).toBe(6);
    expect(s.exported).toBe(0);
    expect(s.buffered).toBe(0);
  });

  it('retry succeeds on a transient failure — nothing dropped', async () => {
    const { impl } = fakeFetch([500, 200]);
    const rec = createAssayUsageRecorder({ token: 'tkn', fetch: impl, batchSize: 1000 });
    for (const e of scriptedSession()) rec.record(e);
    await rec.flush();
    const s = rec.stats();
    expect(s.exported).toBe(6);
    expect(s.dropped).toBe(0);
    expect(s.failed).toBe(1);
  });

  it('the queue is bounded — overflow drops the OLDEST spans, counted', async () => {
    // A fetch that never resolves quickly isn't needed: batchSize high enough
    // that nothing sends, maxBuffered tiny.
    const { impl } = fakeFetch();
    const rec = createAssayUsageRecorder({
      token: 'tkn',
      fetch: impl,
      batchSize: 10_000,
      maxBuffered: 2,
      emitToolSpans: true,
    });
    for (const e of scriptedSession()) rec.record(e); // queues 6 spans total
    expect(rec.stats().dropped).toBeGreaterThan(0);
    expect(rec.stats().buffered).toBeLessThanOrEqual(2 + 1); // bound holds (+pending seal)
  });

  it('record() NEVER throws — a poisoned event is swallowed and counted via onError', () => {
    const errors: string[] = [];
    const rec = createAssayUsageRecorder({
      token: 'tkn',
      fetch: (() => {
        throw new Error('sync fetch explosion');
      }) as unknown as typeof fetch,
      onError: (m) => errors.push(m),
      batchSize: 1,
    });
    // A provider_response with an iso that Date.parse chokes on → NaN times are
    // still strings; then a queue send fires the throwing fetch synchronously.
    expect(() =>
      rec.record({
        type: 'provider_response',
        provider: 'p',
        model: 'm',
        purpose: 'main',
        usage: {},
        latencyMs: 0,
        stopReason: 'end_turn',
        iso: 'not-a-date',
      }),
    ).not.toThrow();
    expect(() => rec.record({ type: 'turn_start', turn: 1, iso: 'x' })).not.toThrow(); // seals + enqueues + sends via the throwing fetch — swallowed
  });
});

describe('S5 — the golden wire fixture (cross-repo conformance artifact)', () => {
  it('the scripted session serializes byte-identically to fixtures/assay-wire-v1.json', async () => {
    const { posts } = await runScripted();
    const body = JSON.parse(String(posts[0]?.init.body)) as WireBody;
    const serialized = `${JSON.stringify(body, null, 2)}\n`;
    if (!existsSync(FIXTURE_PATH)) {
      writeFileSync(FIXTURE_PATH, serialized);
      console.log(`[assay-wire] fixture WRITTEN: ${FIXTURE_PATH} — commit it + vendor to assay`);
    }
    expect(serialized).toBe(readFileSync(FIXTURE_PATH, 'utf8'));
  });
});
