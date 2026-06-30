// Task 4.4 — parity tests for the OpenAI-compatible chat endpoint after it was
// re-seated from its inline `query()` call onto the open SDK's
// `createAgent().run()`. The agent loop is identical and `run()` yields
// `query()`'s `StreamEvent | Message` stream unchanged (the stream-passthrough
// invariant), so these tests pin the five surfaces the re-seat must preserve:
//
//   1. streaming      — the SSE wire shape (role chunk → content deltas →
//                       final stop → [DONE]) is unchanged.
//   2. non-streaming  — the `chat.completion` envelope (assistant text, stop
//                       finish_reason, usage) is unchanged.
//   3. temperature    — the client-controlled `temperature` (the param that
//                       previously BLOCKED this re-seat — Task 4.4a added it to
//                       the createAgent surface) reaches the provider 1:1 via
//                       `AgentConfig`/`PerTurn.temperature`; an absent value
//                       stays absent (the byte-identical no-temperature path).
//   4. microcompaction — `microcompactConfig` (already passed pre-re-seat) still
//                       reaches the turn loop: an on/off discriminating
//                       assertion that prior tool_results clear when enabled and
//                       do NOT when disabled.
//   5. error path     — createAgent converts a thrown provider exception into
//                       `terminal.reason:'error'`; the endpoint still unwraps
//                       `RunResult.terminal` and emits the SAME OpenAI error
//                       envelope/status as the prior bare-Terminal check.
//
// The broader behavioral coverage (abort propagation, session id handling,
// finish-reason mapping, the full error-classifier matrix) lives in the sibling
// openai test files; those all stay green across the re-seat and are the primary
// regression guard. This file targets the re-seat-specific invariants.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MicrocompactConfig } from '../../src/compact/microcompact.js';
import { buildOpenAIApp } from '../../src/openai/app.js';
import { MockProvider } from '../../src/providers/mock.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';
import { MicrocompactTransport } from '../helpers/transportWrappers.js';

const AUTH_HEADERS = {
  authorization: 'Bearer test',
  'content-type': 'application/json',
} as const;

describe('POST /v1/chat/completions — createAgent re-seat parity', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-reseat-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.lastTemperature = undefined;
    MockProvider.throwOnNext = undefined;
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
    MockProvider.lastTemperature = undefined;
    MockProvider.throwOnNext = undefined;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('streaming request still emits role chunk, content deltas, stop, DONE', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const dataLines = (await res.text())
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data: '));

    // Role chunk first.
    const roleChunk = JSON.parse(dataLines[0]?.replace(/^data: /, '') ?? '') as {
      object?: string;
      choices?: Array<{ delta?: { role?: string } }>;
    };
    expect(roleChunk.object).toBe('chat.completion.chunk');
    expect(roleChunk.choices?.[0]?.delta?.role).toBe('assistant');

    // Concatenated content deltas reproduce the mock's full response.
    const concatenated = dataLines
      .filter((l) => l.includes('"content":'))
      .map((l) => {
        const payload = JSON.parse(l.replace(/^data: /, '')) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        return payload.choices?.[0]?.delta?.content ?? '';
      })
      .join('');
    expect(concatenated).toBe('Hello world.');

    // Exactly one final stop chunk, terminated by [DONE].
    expect(dataLines.filter((l) => l.includes('"finish_reason":"stop"')).length).toBe(1);
    expect(dataLines[dataLines.length - 1]).toBe('data: [DONE]');
  });

  test('non-streaming request still returns a chat.completion with the assistant text', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object?: string;
      choices?: Array<{
        message?: { role?: string; content?: string | null };
        finish_reason?: string;
      }>;
      usage?: { total_tokens?: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.choices?.[0]?.message?.role).toBe('assistant');
    expect(body.choices?.[0]?.message?.content).toBe('Hello world.');
    expect(body.choices?.[0]?.finish_reason).toBe('stop');
    expect(typeof body.usage?.total_tokens).toBe('number');
  });

  test('forwards the client temperature through createAgent → provider (non-streaming)', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.2,
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    await res.json();
    // The client temperature reached provider.stream() via
    // PerTurn.temperature → createAgent → query() → provider request.
    expect(MockProvider.lastTemperature).toBe(0.2);
  });

  test('forwards the client temperature through createAgent → provider (streaming)', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(MockProvider.lastTemperature).toBe(0.7);
  });

  test('omits temperature entirely when the client sends none (byte-identical default path)', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    await res.json();
    // No temperature key was sent — the conditional spread on both the route
    // and createAgent leaves query()'s no-temperature default in place.
    expect(MockProvider.lastTemperature).toBeUndefined();
  });

  test('a provider failure still surfaces the same OpenAI error envelope (terminal.reason error unwrapped from RunResult)', async () => {
    // createAgent catches the thrown provider exception and returns it as
    // RunResult.terminal{reason:'error'}; the route unwraps `.terminal` and
    // runs the SAME H2(a) classifier, so the wire shape is unchanged.
    MockProvider.throwOnNext = new Error('simulated provider failure');
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string; type?: string } };
    expect(body.error?.type).toBe('api_error');
    expect(body.error?.message).toContain('simulated provider failure');
  });
});

// Microcompaction parity — an on/off discriminating assertion that the
// re-seated path still threads `microcompactConfig` into the turn loop. The
// OpenAI surface is stateless, so the prior tool_use/tool_result history is
// supplied in the request body (assistant tool_calls + tool messages). The
// MicrocompactTransport (the shared helper) emits a Bash tool_use on iteration
// 0 so the loop reaches the microcompact check after the tool dispatch, then
// "done." on iteration 1 — and it captures every messages[] handed to it, so
// the clearing signal is observable on the continuation call (callMessages[1]).
describe('POST /v1/chat/completions — microcompactConfig still reaches the turn loop', () => {
  /** Build a seeded request body: `pairs` prior Bash tool_use/tool_result
   *  pairs (each tool_result body large enough to dominate the small history
   *  so the 1% trigger fires) followed by a fresh user prompt — so the last
   *  internal message is a user TEXT turn (iteration 0 is NOT a continuation). */
  function seededToolHistoryBody(pairs: number): unknown {
    const messages: unknown[] = [];
    for (let i = 0; i < pairs; i++) {
      const id = `seed-call-${i}`;
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: 'Bash', arguments: JSON.stringify({ command: `echo seed-${i}` }) },
          },
        ],
      });
      messages.push({ role: 'tool', tool_call_id: id, content: `seed-${i} `.repeat(200) });
    }
    messages.push({ role: 'user', content: 'do another bash' });
    return { model: 'harness-default', messages, stream: false };
  }

  /** Drive one seeded non-streaming turn through the OpenAI route under the
   *  given microcompactConfig, with the resolved transport swapped to a
   *  MicrocompactTransport so iteration 0 always issues a Bash. Returns the
   *  transport so the caller can inspect the continuation call's messages. */
  async function runSeededTurn(
    microcompactConfig: MicrocompactConfig,
  ): Promise<MicrocompactTransport> {
    const home = mkdtempSync(join(tmpdir(), 'openai-reseat-mc-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      microcompactConfig,
    });
    try {
      const transport = new MicrocompactTransport({
        toolUseId: 'oai-mc-tool-use-0',
        bashCommand: 'echo oai-mc',
      });
      runtime.resolvedProvider.transport = transport;

      const app = buildOpenAIApp({ runtime, apiKey: 'test' });
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify(seededToolHistoryBody(4)),
      });
      expect(res.status).toBe(200);
      await res.json();
      return transport;
    } finally {
      await runtime.dispose();
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  }

  /** Count tool_result blocks whose content was replaced by the microcompact
   *  clearing marker in the continuation (iteration 1) provider call. */
  function clearedCount(transport: MicrocompactTransport): number {
    const continuation = transport.callMessages[1] ?? [];
    return continuation.flatMap((m) =>
      m.content.filter(
        (b) =>
          b.type === 'tool_result' &&
          typeof b.content === 'string' &&
          b.content.startsWith('[Tool result cleared'),
      ),
    ).length;
  }

  test('prior tool_results CLEAR when microcompaction is enabled (config reached the turn)', async () => {
    const transport = await runSeededTurn({
      enabled: true,
      keepRecent: 1,
      triggerThresholdPct: 1,
      compactableTools: new Set(['Bash']),
    });
    expect(transport.callMessages.length).toBeGreaterThanOrEqual(2);
    expect(clearedCount(transport)).toBeGreaterThan(0);
  });

  test('prior tool_results do NOT clear when microcompaction is disabled (on/off discrimination)', async () => {
    const transport = await runSeededTurn({
      enabled: false,
      keepRecent: 1,
      triggerThresholdPct: 1,
      compactableTools: new Set(['Bash']),
    });
    expect(transport.callMessages.length).toBeGreaterThanOrEqual(2);
    expect(clearedCount(transport)).toBe(0);
  });
});
