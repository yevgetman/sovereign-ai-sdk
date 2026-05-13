import { describe, expect, test } from 'bun:test';
import { buildApp } from '../../src/server/app.js';

describe('buildApp', () => {
  test('mounts /health', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  test('mounts /sessions/:id/events', async () => {
    const app = buildApp();
    const res = await app.request('/sessions/s_smoke/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  });

  test('returns 404 for unknown routes', async () => {
    const app = buildApp();
    const res = await app.request('/no-such-route');
    expect(res.status).toBe(404);
  });
});
