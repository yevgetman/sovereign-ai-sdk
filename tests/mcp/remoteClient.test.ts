// Remote MCP client pool tests. Spin up the in-process Streamable HTTP
// echo-server fixture (a real Bun.serve listener) and connect the pool
// over an actual HTTP round-trip — mirrors the stdio client.test.ts
// philosophy (real transport, no mocks).

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildMcpClientPool } from '../../src/mcp/client.js';
import type { McpClientPool } from '../../src/mcp/types.js';
import { type HttpEchoServer, startHttpEchoServer } from './fixtures/http-echo-server.js';
import { type RedirectFixture, startRedirectFixture } from './fixtures/redirect-server.js';

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

async function withRedirect(): Promise<RedirectFixture> {
  const fx = await startRedirectFixture();
  cleanups.push(() => fx.close());
  return fx;
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
        // Empty env so an ambient SOV_MCP_REMOTE_TOKEN can't override config.
        env: {},
      }),
    );
    await pool.call('remote', 'echo', { text: 'x' });
    expect(srv.seenAuthHeaders).toContain('Bearer cfg-secret');
  });

  test('env SOV_MCP_<ALIAS>_TOKEN overrides config and reaches the server', async () => {
    const srv = await withFixture();
    // Inject the env map (no process.env mutation) — buildMcpClientPool
    // threads it into the pure auth resolver.
    const pool = track(
      await buildMcpClientPool({
        servers: { remote: { type: 'http', url: srv.url, bearerToken: 'cfg-secret' } },
        log: () => {},
        env: { SOV_MCP_REMOTE_TOKEN: 'env-secret' },
      }),
    );
    await pool.call('remote', 'echo', { text: 'x' });
    expect(srv.seenAuthHeaders).toContain('Bearer env-secret');
    expect(srv.seenAuthHeaders).not.toContain('Bearer cfg-secret');
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

describe('remote MCP secret-in-transit (cross-origin redirect)', () => {
  test('Streamable HTTP: a cross-origin redirect leaks NO auth headers', async () => {
    const fx = await withRedirect();
    const pool = track(
      await buildMcpClientPool({
        servers: {
          // bearerToken → Authorization; apiKey → X-API-Key; custom header.
          remote: {
            type: 'http',
            url: fx.configuredUrl,
            bearerToken: 'secret-bearer',
            apiKey: 'secret-apikey',
            headers: { 'X-Tenant': 'secret-tenant' },
          },
        },
        log: () => {},
        connectTimeoutMs: 4000,
        env: {},
      }),
    );
    // The connect fails (the attacker isn't an MCP server), which is fine —
    // we only care about what crossed the origin boundary.
    expect(pool.servers()).toHaveLength(0);

    // The redirect MUST have actually reached the attacker (proves the test
    // exercised the redirect path, not a no-op).
    expect(fx.attackerHits.length).toBeGreaterThan(0);
    for (const hit of fx.attackerHits) {
      expect(hit.authorization).toBeUndefined();
      expect(hit['x-api-key']).toBeUndefined();
      expect(hit['x-tenant']).toBeUndefined();
    }
    // Belt and suspenders: no header VALUE leaked under any name.
    const allValues = fx.attackerHits.flatMap((h) => Object.values(h));
    expect(allValues).not.toContain('Bearer secret-bearer');
    expect(allValues).not.toContain('secret-apikey');
    expect(allValues).not.toContain('secret-tenant');
  }, 10_000);

  test('SSE: a cross-origin redirect on the GET stream leaks NO auth headers', async () => {
    const fx = await withRedirect();
    const pool = track(
      await buildMcpClientPool({
        servers: {
          remote: {
            type: 'sse',
            url: fx.configuredUrl,
            bearerToken: 'secret-bearer',
            apiKey: 'secret-apikey',
            headers: { 'X-Tenant': 'secret-tenant' },
          },
        },
        log: () => {},
        connectTimeoutMs: 4000,
        env: {},
      }),
    );
    expect(pool.servers()).toHaveLength(0);

    expect(fx.attackerHits.length).toBeGreaterThan(0);
    for (const hit of fx.attackerHits) {
      expect(hit.authorization).toBeUndefined();
      expect(hit['x-api-key']).toBeUndefined();
      expect(hit['x-tenant']).toBeUndefined();
    }
    const allValues = fx.attackerHits.flatMap((h) => Object.values(h));
    expect(allValues).not.toContain('Bearer secret-bearer');
    expect(allValues).not.toContain('secret-apikey');
    expect(allValues).not.toContain('secret-tenant');
  }, 10_000);
});
