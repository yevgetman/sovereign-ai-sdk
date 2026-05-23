import { describe, expect, test } from 'bun:test';
import { buildOpenAIApp } from '../../src/openai/app.js';
import type { Runtime } from '../../src/server/runtime.js';

describe('GET /health', () => {
  test('returns 200 with ok and version (no auth required)', async () => {
    const app = buildOpenAIApp({ runtime: null as unknown as Runtime, apiKey: 'test-key' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; version?: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
  });
});
