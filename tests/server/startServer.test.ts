import { describe, expect, test } from 'bun:test';
import { startServer } from '../../src/server/index.js';

describe('startServer', () => {
  test('binds to a free port on 127.0.0.1 and serves /health', async () => {
    const { port, stop } = await startServer();
    try {
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await stop();
    }
  });

  test('stop() closes the server (subsequent fetch fails)', async () => {
    const { port, stop } = await startServer();
    await stop();
    let threw = false;
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
