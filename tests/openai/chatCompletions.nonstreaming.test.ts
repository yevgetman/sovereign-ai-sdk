// Phase 18 T2 — integration test: POST /v1/chat/completions (non-streaming
// branch) against a runtime built with the mock provider. Validates the
// end-to-end shape: 200 OK with a chat.completion envelope, an assistant
// message with text content, a 'stop' finish_reason, and a usage block.
// Also covers 401 on missing auth, 400 on malformed JSON, and 400 on
// unknown model name.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenAIApp } from '../../src/openai/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('POST /v1/chat/completions (non-streaming)', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-chat-'));
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

  test('returns OpenAI-shaped chat.completion with the assistant text', async () => {
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
    const body = (await res.json()) as {
      id?: string;
      object?: string;
      created?: number;
      model?: string;
      choices?: Array<{
        index?: number;
        message?: { role?: string; content?: string | null };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(typeof body.created).toBe('number');
    expect(body.model).toBe('harness-default');
    expect(body.choices?.[0]?.index).toBe(0);
    expect(body.choices?.[0]?.message?.role).toBe('assistant');
    // MockProvider's default branch emits "Hello world." across two text
    // deltas. blocksToOpenAI concatenates the resulting text blocks.
    expect(body.choices?.[0]?.message?.content).toBe('Hello world.');
    expect(body.choices?.[0]?.finish_reason).toBe('stop');
    expect(body.usage).toBeDefined();
    expect(typeof body.usage?.prompt_tokens).toBe('number');
    expect(typeof body.usage?.completion_tokens).toBe('number');
    expect(typeof body.usage?.total_tokens).toBe('number');
  });

  test('omits stream field (defaulted to false) still goes through non-streaming branch', async () => {
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
    const body = (await res.json()) as { object?: string };
    expect(body.object).toBe('chat.completion');
  });

  test('returns 400 when model is unknown', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-99', messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe('invalid_request_error');
    expect(body.error?.message).toBeTruthy();
  });

  test('returns 401 without Authorization header', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  test('returns 400 on malformed JSON body', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe('invalid_request_error');
  });

  test('returns 400 when messages array is missing', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'harness-default' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe('invalid_request_error');
  });
});
