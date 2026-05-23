// Phase 18 T7 — integration test: GET /v1/models against a runtime built
// with the mock provider. Validates the OpenAI /v1/models shape:
// { object: 'list', data: [{ id, object: 'model', created, owned_by }, ...] }.
// Covers: 200 + list shape, presence of harness-default and the canonical
// Anthropic claude ids, per-entry shape, and 401 on missing auth.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenAIApp } from '../../src/openai/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('GET /v1/models', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-models-'));
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

  test('returns 200 with OpenAI-shaped list', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/models', {
      headers: { authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object?: string;
      data?: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data?.length ?? 0).toBeGreaterThan(0);
  });

  test('includes harness-default', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/models', {
      headers: { authorization: 'Bearer test' },
    });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain('harness-default');
  });

  test('includes the canonical Anthropic claude models', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/models', {
      headers: { authorization: 'Bearer test' },
    });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = new Set(body.data.map((m) => m.id));
    expect(ids.has('claude-opus-4-7')).toBe(true);
    expect(ids.has('claude-sonnet-4-6')).toBe(true);
    expect(ids.has('claude-haiku-4-5-20251001')).toBe(true);
  });

  test('each model entry has the OpenAI shape', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/models', {
      headers: { authorization: 'Bearer test' },
    });
    const body = (await res.json()) as {
      data: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };
    for (const m of body.data) {
      expect(typeof m.id).toBe('string');
      expect(m.object).toBe('model');
      expect(typeof m.created).toBe('number');
      expect(typeof m.owned_by).toBe('string');
    }
  });

  test('requires authorization', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/models'); // no auth header
    expect(res.status).toBe(401);
  });
});
