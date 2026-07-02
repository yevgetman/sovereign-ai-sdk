import { describe, expect, test } from 'bun:test';
import { buildOpenAIApp } from '../../src/openai/app.js';
import type { Runtime } from '../../src/server/runtime.js';
import { VERSION as WRAPPER_VERSION } from '../../src/wrapperVersion.js';

describe('GET /health', () => {
  test('returns 200 with ok and version (no auth required)', async () => {
    const app = buildOpenAIApp({ runtime: null as unknown as Runtime, apiKey: 'test-key' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; version?: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
  });

  test('version comes from the wrapper version source (harness line)', async () => {
    // Task 3.2 pin (mirrors the gateway sibling's Task 3.1 pin) — /health must
    // report the HARNESS (root package.json) version via src/wrapperVersion.ts,
    // not the SDK package's 0.1.x line. The route captures SOV_VERSION at
    // module load, so honor an env override the same way it does.
    const app = buildOpenAIApp({ runtime: null as unknown as Runtime, apiKey: 'test-key' });
    const res = await app.request('/health');
    const body = (await res.json()) as { ok?: boolean; version?: string };
    expect(body.version).toBe(process.env.SOV_VERSION ?? WRAPPER_VERSION);
  });
});
