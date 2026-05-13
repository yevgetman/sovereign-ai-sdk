import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { healthRoute } from '../../src/server/routes/health.js';

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
});
