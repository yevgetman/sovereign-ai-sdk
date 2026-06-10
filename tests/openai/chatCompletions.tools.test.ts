// Phase 18 T6 — integration test: POST /v1/chat/completions with tool
// calls. Boots a runtime with the mock provider in tool-use mode, hits
// the route with `stream: true` and `stream: false`, and asserts the
// wire surfaces tool_calls + hermes.tool.progress side-channel events.
//
// Mock provider's tool-use mode emits a two-call sequence:
//   call 1: preamble text ("Let me " + "check.") + tool_use(Bash)
//   call 2: "done." text once a tool_result lands in history
// The harness's query() loop runs the Bash tool between the two calls
// (echo is on the read-only allowlist; the dispatch reads stdout into
// the tool_result block). The translator (T6) projects this onto the
// OpenAI wire as:
//   - role chunk
//   - content delta(s) for "Let me " + "check."
//   - tool_calls chunk for the Bash invocation
//   - hermes.tool.progress event for the tool_result
//   - content delta for "done."
//   - final stop chunk
//   - [DONE]
//
// This pins the canonical sequence end-to-end; the translator unit
// tests in tests/openai/streaming/toolUse.test.ts pin the slice-by-slice
// shapes against synthetic generators.
//
// Tool-use mode is a global static on MockProvider — wrap in try/finally
// so a failed assertion can't leak the flag into sibling suites.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenAIApp } from '../../src/openai/app.js';
import { MockProvider } from '../../src/providers/mock.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('POST /v1/chat/completions with tool calls', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-tools-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = true;
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
    MockProvider.toolUseMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('streaming response emits tool_calls chunk and hermes.tool.progress event', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'run something' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await res.text();

    // Body should contain at least one tool_calls chunk for the Bash
    // invocation. The mock's tool_use id is deterministic: MOCK_TOOL_USE_ID.
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"Bash"');

    // Body should contain at least one hermes.tool.progress side-channel
    // event for the tool execution. The `echo hello-from-mock` command
    // is on Bash's read-only allowlist, so it actually runs and emits a
    // success tool_result (no is_error).
    expect(body).toContain('event: hermes.tool.progress');

    // Both the preamble ("Let me " + "check.") and the continuation
    // ("done.") text deltas surface as `content` chunks.
    expect(body).toContain('"content":"Let me "');
    expect(body).toContain('"content":"check."');
    expect(body).toContain('"content":"done."');

    // Exactly one final-stop chunk + DONE terminator (D9: never
    // `tool_calls`; the harness runs tools internally within the same
    // request, so the client sees a single terminal `stop`).
    const finishStopMatches = body.match(/"finish_reason":"stop"/g) ?? [];
    expect(finishStopMatches.length).toBe(1);
    expect(body).toContain('data: [DONE]');
  });

  test('streaming wire ordering: text deltas precede tool_calls precede progress precede continuation', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'run something' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    const preambleIdx = body.indexOf('"content":"check."');
    const toolCallsIdx = body.indexOf('"tool_calls"');
    const progressIdx = body.indexOf('event: hermes.tool.progress');
    const continuationIdx = body.indexOf('"content":"done."');
    const stopIdx = body.indexOf('"finish_reason":"stop"');
    const doneIdx = body.indexOf('data: [DONE]');

    expect(preambleIdx).toBeGreaterThan(-1);
    expect(toolCallsIdx).toBeGreaterThan(preambleIdx);
    expect(progressIdx).toBeGreaterThan(toolCallsIdx);
    expect(continuationIdx).toBeGreaterThan(progressIdx);
    expect(stopIdx).toBeGreaterThan(continuationIdx);
    expect(doneIdx).toBeGreaterThan(stopIdx);
  });

  test('tool_calls chunk carries the resolved Bash arguments JSON', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'run something' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    // Find the tool_calls data line and parse its payload.
    const dataLines = body
      .split('\n\n')
      .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
      .filter((l): l is string => !!l && l.includes('"tool_calls"'));
    expect(dataLines.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse((dataLines[0] ?? '').replace(/^data: /, '')) as {
      choices: Array<{
        delta: {
          tool_calls: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string | null;
      }>;
    };
    const call = payload.choices[0]?.delta.tool_calls[0];
    expect(call?.id).toBeTruthy();
    expect(call?.type).toBe('function');
    expect(call?.function.name).toBe('Bash');
    // Arguments JSON should parse and contain the echo command.
    const args = JSON.parse(call?.function.arguments ?? '{}') as { command?: string };
    expect(args.command).toBe('echo hello-from-mock');
    // D9: finish_reason is null on tool_calls chunks (never 'tool_calls').
    expect(payload.choices[0]?.finish_reason).toBeNull();
  });

  test('hermes.tool.progress payload carries the tool_use_id and output', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'run something' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    // Extract the progress payload.
    const progressBlock = body
      .split('\n\n')
      .find((block) => block.startsWith('event: hermes.tool.progress'));
    expect(progressBlock).toBeDefined();
    const dataLine = (progressBlock ?? '').split('\n').find((l) => l.startsWith('data: '));
    const payload = JSON.parse((dataLine ?? '').replace(/^data: /, '')) as {
      tool_use_id?: string;
      output?: string;
      is_error?: boolean;
    };
    expect(payload.tool_use_id).toBeTruthy();
    // The echo command's stdout makes it through end-to-end.
    expect(payload.output).toContain('hello-from-mock');
    // The Bash run succeeded — no is_error should be present.
    expect(payload.is_error).toBeUndefined();
  });

  test('non-streaming response includes tool_calls in the final assistant message', async () => {
    // The mock's tool-use mode runs to terminal within the same request:
    // call 1 emits the tool_use, runTools executes Bash, call 2 emits the
    // "done." text. The non-streaming branch projects the LAST assistant
    // message through blocksToOpenAI() — which is the second call's
    // text-only message ("done."). The earlier tool_use lives only in
    // the first model call's assistant_message and is consumed by
    // runTools before the second call.
    //
    // So the non-streaming endpoint legitimately returns content='done.'
    // with NO tool_calls — the client never sees the intermediate tool
    // call. This matches D9 (harness runs tools internally; client wire
    // is single-turn from their perspective) and is the same contract
    // the streaming branch enforces via finish_reason: 'stop' (never
    // 'tool_calls').
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'run something' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices?: Array<{
        message?: { role?: string; content?: string | null; tool_calls?: unknown };
        finish_reason?: string;
      }>;
    };
    expect(body.choices?.[0]?.message?.role).toBe('assistant');
    // Final assistant message is the continuation text "done." (no
    // tool_calls — the earlier Bash call was internal to the harness).
    expect(body.choices?.[0]?.message?.content).toBe('done.');
    expect(body.choices?.[0]?.message?.tool_calls).toBeUndefined();
    // D9: finish_reason is `stop`, never `tool_calls`.
    expect(body.choices?.[0]?.finish_reason).toBe('stop');
  });
});

// FIX 4 — query() emits usage_delta per provider call (cumulative within a
// call, reset at each new call). The non-streaming drain previously kept
// only the LAST event, so an N-call tool loop reported only the final
// call's tokens. The drain must ACCUMULATE: sum each provider call's final
// input/output tokens into the response usage.
describe('POST /v1/chat/completions (non-streaming) usage accumulation across a tool loop', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-usage-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Script a 2-provider-call tool loop:
    //   call 1: tool_use(Bash echo)  → usage_delta { outputTokens: 1 }
    //   call 2: text("done.")        → usage_delta { outputTokens: 1 }
    // Each scripted entry emits exactly one usage_delta carrying that
    // call's tokens. The correct accumulated total is the SUM across both
    // calls (2), not the last call's value (1).
    MockProvider.toolUseScript = [
      { kind: 'tool_use', name: 'Bash', input: { command: 'echo hello-usage' } },
      { kind: 'text', text: 'done.' },
    ];
    // preflight: false so the boot preflight stream() call doesn't consume
    // the first scripted entry; the request below must drive both calls.
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      cronEnabled: false,
    });
    MockProvider.resetScriptCursor();
  });

  afterEach(async () => {
    await runtime.dispose();
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('reported usage equals the sum of both provider calls (not just the last)', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'run something' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    };
    // Two calls ran (the loop reached the "done." continuation).
    expect(body.choices?.[0]?.message?.content).toBe('done.');
    // Each call emitted outputTokens: 1 → the accumulated completion_tokens
    // is 2. Before FIX 4 the drain kept only the last call → it would be 1.
    expect(body.usage?.completion_tokens).toBe(2);
    expect(body.usage?.prompt_tokens).toBe(0);
    expect(body.usage?.total_tokens).toBe(2);
  });
});
