import { describe, expect, test } from 'bun:test';
import { findFreePort } from '../../src/server/port.js';

describe('findFreePort', () => {
  test('returns a usable port in the dynamic range', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThan(65536);
  });

  test('returns a port we can immediately bind to', async () => {
    const port = await findFreePort();
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test('returns distinct ports on parallel calls', async () => {
    // findFreePort opens a probe, reads the assigned port, then stops the
    // probe. Two parallel invocations should still pick different ports
    // because their probes coexist — the kernel hands each one a unique
    // ephemeral. Asserting distinct ports here is an actual exercise of
    // the unit (previously the test reached past findFreePort and probed
    // Bun.serve directly).
    const [a, b] = await Promise.all([findFreePort(), findFreePort()]);
    expect(a).not.toBe(b);
  });
});
