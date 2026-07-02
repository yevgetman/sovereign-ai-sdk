import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { healthRoute } from '../../src/server/routes/health.js';
import { VERSION as WRAPPER_VERSION } from '../../src/wrapperVersion.js';

describe('healthRoute', () => {
  test('GET /health returns { ok: true, version }', async () => {
    const app = new Hono().route('/', healthRoute);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  test('GET /health version comes from the wrapper version source (harness line)', async () => {
    // Task 3.1 pin — /health must report the HARNESS (root package.json)
    // version via src/wrapperVersion.ts, not src/version.ts, which moves
    // into packages/sdk/ in Phase 3 and flips to the SDK's 0.1.x line.
    // health.ts captures SOV_VERSION at module load, so honor an env
    // override the same way it does.
    const app = new Hono().route('/', healthRoute);
    const res = await app.request('/health');
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.version).toBe(process.env.SOV_VERSION ?? WRAPPER_VERSION);
  });
});
