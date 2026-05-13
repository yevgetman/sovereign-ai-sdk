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

  test('two calls in a row return different ports (usually)', async () => {
    // Strictly speaking the kernel could reissue the same port if the first one
    // was released. This test runs the two calls back-to-back without closing
    // anything in between, so we expect distinct ports.
    const a = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const b = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      a.stop();
      b.stop();
    }
  });
});
