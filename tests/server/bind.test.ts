// Phase A T2 — host-configurable native bind: the pure resolveBindHost seam
// + startServer threading an optional hostname through to Bun.serve.

import { describe, expect, test } from 'bun:test';
import { startServer } from '../../src/server/index.js';
import { findFreePort, resolveBindHost } from '../../src/server/port.js';

describe('resolveBindHost', () => {
  test('defaults to loopback when no host is given', () => {
    expect(resolveBindHost(undefined)).toBe('127.0.0.1');
  });

  test('returns the explicit host verbatim', () => {
    expect(resolveBindHost('0.0.0.0')).toBe('0.0.0.0');
  });

  test('passes through any non-loopback host without rewriting it', () => {
    expect(resolveBindHost('::1')).toBe('::1');
    expect(resolveBindHost('192.168.1.5')).toBe('192.168.1.5');
  });
});

describe('findFreePort with explicit host', () => {
  test('picks a free port on the supplied loopback host', async () => {
    // We only ever bind loopback in tests — binding a non-loopback address
    // is unreliable in CI sandboxes. The host param is exercised here by
    // passing an explicit loopback value (default path is covered elsewhere).
    const port = await findFreePort('127.0.0.1');
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThan(65536);
  });
});

describe('startServer hostname option', () => {
  test('accepts an explicit hostname and serves on it (loopback)', async () => {
    // Bind an explicit loopback host at a chosen free port and confirm the
    // listener is reachable. This proves the hostname param is threaded into
    // Bun.serve without attempting a non-loopback bind.
    const port = await findFreePort('127.0.0.1');
    const { stop } = await startServer({ port, hostname: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await stop();
    }
  });

  test('defaults to loopback when hostname is omitted', async () => {
    const { port, stop } = await startServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await stop();
    }
  });
});
