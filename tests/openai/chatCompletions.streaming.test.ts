// Phase 18 T5 — integration test: POST /v1/chat/completions (streaming
// branch). Boots a runtime with the mock provider, hits the route with
// `stream: true`, and drains the SSE response body. Asserts the OpenAI
// wire format: role chunk, content deltas, a final stop chunk, and the
// literal `data: [DONE]` terminator. Also verifies the non-streaming
// branch is unchanged (T2's behavior) and that the 401 auth gate fires
// before the stream switch.
//
// The test surface uses Hono's `app.request(path, init)` — it drains
// the streamSSE body through the streaming machinery and returns a
// fetch-shaped Response. Real clients use a streaming consumer; this
// is the right surface for pinning the wire shape.
//
// Mock provider emits "Hello world." across two text deltas. The
// translator (T4) emits: role chunk + delta('Hello') + delta(' world.')
// + final stop + [DONE]. The assistant_message event the mock emits
// after streaming is intentionally dropped by the translator (R2 in
// the plan).
//
// MockProvider's `assistant_message` event re-emits the FULL assistant
// content after streaming. The translator suppresses that to avoid
// duplicating text on the wire — see sseTranslator.test.ts (R2 test).
// The integration test here asserts the exact wire we expect a real
// OpenAI client to consume.
//
// NOTE — Hono's `app.request()` does not stream chunks back lazily;
// it collects the whole body into a string before returning. That's
// fine here: we're pinning the wire format, not backpressure
// semantics. End-to-end backpressure is the host's concern.
//
// The lint/perf rule on `delete process.env.X` mirrors the
// non-streaming test — `delete` is required to truly unset an env
// key (assigning `undefined` stringifies to the literal "undefined").

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenAIApp } from '../../src/openai/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('POST /v1/chat/completions (streaming)', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-stream-'));
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
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('returns SSE stream with role chunk, content deltas, final stop, DONE', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
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
    const dataLines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data: '));

    // role + at least one content delta + final + DONE = >=4 lines.
    expect(dataLines.length).toBeGreaterThanOrEqual(4);

    // First data line is the role chunk.
    const firstPayload = dataLines[0]?.replace(/^data: /, '') ?? '';
    const roleChunk = JSON.parse(firstPayload) as {
      object?: string;
      model?: string;
      choices?: Array<{ delta?: { role?: string }; finish_reason?: string | null }>;
    };
    expect(roleChunk.object).toBe('chat.completion.chunk');
    expect(roleChunk.model).toBe('harness-default');
    expect(roleChunk.choices?.[0]?.delta?.role).toBe('assistant');
    expect(roleChunk.choices?.[0]?.finish_reason).toBeNull();

    // At least one content delta chunk exists.
    const contentLines = dataLines.filter((l) => l.includes('"content":'));
    expect(contentLines.length).toBeGreaterThanOrEqual(1);

    // Concatenated content equals the mock's full response.
    const concatenated = contentLines
      .map((l) => {
        const payload = JSON.parse(l.replace(/^data: /, '')) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        return payload.choices?.[0]?.delta?.content ?? '';
      })
      .join('');
    expect(concatenated).toBe('Hello world.');

    // Exactly one final-stop chunk.
    const finalLines = dataLines.filter((l) => l.includes('"finish_reason":"stop"'));
    expect(finalLines.length).toBe(1);

    // Last data line is the DONE terminator.
    const lastLine = dataLines[dataLines.length - 1];
    expect(lastLine).toBe('data: [DONE]');
  });

  test('non-streaming branch still returns JSON when stream:false', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { object?: string };
    expect(body.object).toBe('chat.completion');
  });

  test('default (no stream field) returns non-streaming JSON', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  test('returns 401 if Authorization missing on a streaming request', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(401);
  });
});
