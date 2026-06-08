// Remote MCP client pool tests. Spin up the in-process Streamable HTTP
// echo-server fixture (a real Bun.serve listener) and connect the pool
// over an actual HTTP round-trip — mirrors the stdio client.test.ts
// philosophy (real transport, no mocks).

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildMcpClientPool } from '../../src/mcp/client.js';
import type { McpClientPool } from '../../src/mcp/types.js';
import { type HttpEchoServer, startHttpEchoServer } from './fixtures/http-echo-server.js';

const STDIO_FIXTURE = join(__dirname, 'fixtures', 'echo-server.ts');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function withFixture(): Promise<HttpEchoServer> {
  const srv = await startHttpEchoServer();
  cleanups.push(() => srv.close());
  return srv;
}

function track(pool: McpClientPool): McpClientPool {
  cleanups.push(() => pool.shutdown());
  return pool;
}

describe('remote MCP client pool (Streamable HTTP)', () => {
  test('connects, lists tools, calls a tool, surfaces isError', async () => {
    const srv = await withFixture();
    const pool = track(
      await buildMcpClientPool({
        servers: { remote: { type: 'http', url: srv.url } },
        log: () => {},
      }),
    );

    const servers = pool.servers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe('remote');
    const toolNames = (servers[0]?.tools ?? []).map((t) => t.toolName).sort();
    expect(toolNames).toEqual(['boom', 'echo']);

    const ok = await pool.call('remote', 'echo', { text: 'hello remote' });
    expect(ok.text).toBe('hello remote');
    expect(ok.isError).toBe(false);

    const bad = await pool.call('remote', 'boom', {});
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('something went wrong');
  });

  test('forwards the bearer token from config as Authorization', async () => {
    const srv = await withFixture();
    const pool = track(
      await buildMcpClientPool({
        servers: { remote: { type: 'http', url: srv.url, bearerToken: 'cfg-secret' } },
        log: () => {},
      }),
    );
    await pool.call('remote', 'echo', { text: 'x' });
    expect(srv.seenAuthHeaders).toContain('Bearer cfg-secret');
  });

  test('env SOV_MCP_<ALIAS>_TOKEN overrides config and reaches the server', async () => {
    const srv = await withFixture();
    const prev = process.env.SOV_MCP_REMOTE_TOKEN;
    process.env.SOV_MCP_REMOTE_TOKEN = 'env-secret';
    try {
      const pool = track(
        await buildMcpClientPool({
          servers: { remote: { type: 'http', url: srv.url, bearerToken: 'cfg-secret' } },
          log: () => {},
        }),
      );
      await pool.call('remote', 'echo', { text: 'x' });
      expect(srv.seenAuthHeaders).toContain('Bearer env-secret');
      expect(srv.seenAuthHeaders).not.toContain('Bearer cfg-secret');
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'SOV_MCP_REMOTE_TOKEN');
      else process.env.SOV_MCP_REMOTE_TOKEN = prev;
    }
  });

  test('dead remote URL is logged-and-skipped, good server still connects, log has no token', async () => {
    const srv = await withFixture();
    const logs: string[] = [];
    const pool = track(
      await buildMcpClientPool({
        servers: {
          good: { type: 'http', url: srv.url, bearerToken: 'super-secret-token' },
          // Unroutable port → connection refused fast.
          dead: { type: 'http', url: 'http://127.0.0.1:1/mcp', bearerToken: 'dead-secret' },
        },
        log: (m) => logs.push(m),
        connectTimeoutMs: 4000,
      }),
    );

    expect(pool.servers().map((s) => s.name)).toEqual(['good']);
    expect(logs.some((m) => m.includes('dead') && m.includes('failed'))).toBe(true);
    // Secrets must never appear in any log line.
    expect(logs.some((m) => m.includes('super-secret-token') || m.includes('dead-secret'))).toBe(
      false,
    );
  });

  test('mixed stdio + http pool spans both transports', async () => {
    const srv = await withFixture();
    const pool = track(
      await buildMcpClientPool({
        servers: {
          local: { type: 'stdio', command: 'bun', args: [STDIO_FIXTURE] },
          remote: { type: 'http', url: srv.url },
        },
        log: () => {},
      }),
    );

    const names = pool
      .servers()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(['local', 'remote']);

    const local = await pool.call('local', 'echo', { text: 'local-hi' });
    expect(local.text).toBe('local-hi');
    const remote = await pool.call('remote', 'echo', { text: 'remote-hi' });
    expect(remote.text).toBe('remote-hi');
  });

  test('connect timeout fires on a non-responding endpoint', async () => {
    const logs: string[] = [];
    // A black-hole host (TEST-NET-1, RFC 5737) never completes the TCP
    // handshake, so the connect Promise.race loses to the timeout.
    const pool = track(
      await buildMcpClientPool({
        servers: { hung: { type: 'http', url: 'http://192.0.2.1:9/mcp' } },
        log: (m) => logs.push(m),
        connectTimeoutMs: 300,
      }),
    );
    expect(pool.servers()).toHaveLength(0);
    expect(logs.some((m) => m.includes('hung') && m.includes('failed'))).toBe(true);
  }, 10_000);
});
