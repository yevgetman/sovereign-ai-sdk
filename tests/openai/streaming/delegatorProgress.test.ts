// Phase 2 T7 — Bus-subscriber side-channel SSE events for delegator
// progress on the chat completions streaming branch.
//
// Two concerns:
//
//   1. `buildDelegatorProgressPayload(event)` is a thin JSON helper —
//      verbatim serialization of the four delegator wire-event shapes so
//      the OpenAI side-channel sees the same payload the TUI / `sov drive`
//      consumers see on the GET /events SSE wire. Unit-tested here.
//
//   2. The chat completions streaming branch (`stream: true`) subscribes
//      to the per-session event bus before driving `translateStream` and
//      emits `event: hermes.delegator.progress\ndata: <json>\n\n` SSE
//      frames for each delegator_* event published onto the bus. Tested
//      end-to-end by pre-seeding the bus with synthetic delegator events
//      (the synthesis closure is independently covered in
//      `tests/router/progressEvents.test.ts`; here we exercise the wire
//      surface in isolation) and asserting the side-channel frames appear
//      in the raw SSE body.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenAIApp } from '../../../src/openai/app.js';
import { buildDelegatorProgressPayload } from '../../../src/openai/streaming/chunks.js';
import { __test_resetAllBuses, getOrCreateBus } from '../../../src/server/eventBus.js';
import { type Runtime, buildRuntime } from '../../../src/server/runtime.js';

describe('buildDelegatorProgressPayload', () => {
  test('serializes delegator_plan event', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_plan',
      seq: 1,
      sessionId: 'root',
    });
    const parsed = JSON.parse(payload) as { type: string; sessionId: string };
    expect(parsed.type).toBe('delegator_plan');
    expect(parsed.sessionId).toBe('root');
  });

  test('serializes delegator_atom_started event', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_atom_started',
      seq: 2,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      promptPreview: 'list files',
    });
    const parsed = JSON.parse(payload) as {
      atomIndex: number;
      laneName: string;
      promptPreview: string;
    };
    expect(parsed.atomIndex).toBe(0);
    expect(parsed.laneName).toBe('cheap-task');
    expect(parsed.promptPreview).toBe('list files');
  });

  test('serializes delegator_atom_complete event', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_atom_complete',
      seq: 3,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      success: true,
      durationMs: 50,
    });
    const parsed = JSON.parse(payload) as { success: boolean; durationMs: number };
    expect(parsed.success).toBe(true);
    expect(parsed.durationMs).toBe(50);
  });

  test('serializes delegator_complete event with lane distribution', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_complete',
      seq: 4,
      sessionId: 'root',
      totalAtomCount: 3,
      laneDistribution: { 'cheap-task': 2, 'moderate-task': 1 },
    });
    const parsed = JSON.parse(payload) as {
      totalAtomCount: number;
      laneDistribution: Record<string, number>;
    };
    expect(parsed.totalAtomCount).toBe(3);
    expect(parsed.laneDistribution['cheap-task']).toBe(2);
    expect(parsed.laneDistribution['moderate-task']).toBe(1);
  });
});

describe('chat completions emits hermes.delegator.progress side-channel events', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    __test_resetAllBuses();
    home = mkdtempSync(join(tmpdir(), 'deleg-sse-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    __test_resetAllBuses();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('bus-published delegator events flow through as side-channel SSE frames', async () => {
    // Pre-seed the per-session bus with the four delegator_* events the
    // synthesizer would publish during a real delegator dispatch. The bus
    // buffers events until the subscriber attaches (see eventBus.ts), so
    // events published before the streaming request starts will drain
    // immediately when the chat completions route subscribes.
    //
    // The OpenAI route namespaces sessionIds with `openai:`; we use a
    // known client id via the X-Session-Id header so we know what the
    // internal id will be.
    const clientSessionId = 'deleg-progress-test';
    const internalSessionId = `openai:${clientSessionId}`;
    const bus = getOrCreateBus(internalSessionId);
    bus.publish({
      type: 'delegator_plan',
      seq: bus.nextSeq(),
      sessionId: internalSessionId,
    });
    bus.publish({
      type: 'delegator_atom_started',
      seq: bus.nextSeq(),
      sessionId: internalSessionId,
      atomIndex: 0,
      laneName: 'cheap-task',
      promptPreview: 'do the trivial thing',
    });
    bus.publish({
      type: 'delegator_atom_complete',
      seq: bus.nextSeq(),
      sessionId: internalSessionId,
      atomIndex: 0,
      laneName: 'cheap-task',
      success: true,
      durationMs: 42,
    });
    bus.publish({
      type: 'delegator_complete',
      seq: bus.nextSeq(),
      sessionId: internalSessionId,
      totalAtomCount: 1,
      laneDistribution: { 'cheap-task': 1 },
    });

    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': clientSessionId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = await res.text();

    // Verify each delegator wire event surfaced as a side-channel SSE
    // frame interleaved with the main OpenAI chunks.
    expect(body).toContain('event: hermes.delegator.progress');
    const lines = body.split('\n');
    const progressEvents: Array<{ type: string }> = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const currentLine = lines[i];
      const nextLine = lines[i + 1];
      if (
        currentLine === 'event: hermes.delegator.progress' &&
        nextLine !== undefined &&
        nextLine.startsWith('data: ')
      ) {
        const json = nextLine.slice('data: '.length);
        progressEvents.push(JSON.parse(json) as { type: string });
      }
    }
    const types = progressEvents.map((e) => e.type);
    expect(types).toContain('delegator_plan');
    expect(types).toContain('delegator_atom_started');
    expect(types).toContain('delegator_atom_complete');
    expect(types).toContain('delegator_complete');

    // Spot-check one payload: the atom_started event should carry the
    // fields we seeded.
    const atomStarted = progressEvents.find((e) => e.type === 'delegator_atom_started') as
      | undefined
      | {
          type: string;
          atomIndex: number;
          laneName: string;
          promptPreview: string;
        };
    expect(atomStarted?.atomIndex).toBe(0);
    expect(atomStarted?.laneName).toBe('cheap-task');
    expect(atomStarted?.promptPreview).toBe('do the trivial thing');

    // Non-delegator events on the bus must NOT show up under the
    // hermes.delegator.progress event line — the subscriber filters by
    // type, leaving the main OpenAI stream untouched.
    // (The mock's default Hello-world stream emits text deltas; those
    //  flow via `translateStream`, not the side-channel.)
    expect(body).toContain('data: [DONE]');
  });

  test('non-delegator bus events are not forwarded to the side-channel', async () => {
    // Pre-seed the bus with a text_delta event. The subscriber filters by
    // type, so this event must NOT appear under
    // `event: hermes.delegator.progress` in the SSE output.
    const clientSessionId = 'non-deleg-test';
    const internalSessionId = `openai:${clientSessionId}`;
    const bus = getOrCreateBus(internalSessionId);
    bus.publish({
      type: 'text_delta',
      seq: bus.nextSeq(),
      sessionId: internalSessionId,
      block: 0,
      text: 'should-not-leak',
    });

    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': clientSessionId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    // The hermes.delegator.progress event line must NOT carry the bus's
    // text_delta payload — only delegator_* events flow through.
    expect(body).not.toContain('event: hermes.delegator.progress\ndata: {"type":"text_delta"');
    // The text_delta text itself ("should-not-leak") must not appear on
    // the wire anywhere — the bus subscriber filters it out, and the
    // main OpenAI stream is driven by the mock's own provider, not the
    // bus.
    expect(body).not.toContain('should-not-leak');
  });
});
