// Remote MCP client pool tests. Spin up the in-process Streamable HTTP
// echo-server fixture (a real Bun.serve listener) and connect the pool
// over an actual HTTP round-trip — mirrors the stdio client.test.ts
// philosophy (real transport, no mocks).

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveMcpHeaders } from '@yevgetman/sov-sdk/mcp/auth';
import { buildMcpClientPool, sanitizeConnectError } from '@yevgetman/sov-sdk/mcp/client';
import { buildSafeFetch } from '@yevgetman/sov-sdk/mcp/safeFetch';
import type { McpClientPool, McpServerConfig } from '@yevgetman/sov-sdk/mcp/types';
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

    // PRECONDITION: the secrets must have actually been attached to the
    // LEGIT first hop — otherwise "absent at attacker" is trivially true and
    // the test proves nothing. The dynamic custom header (x-tenant) proves
    // the real wiring passes cfg.headers names through, not a hand-fed list.
    expect(fx.configuredHits.length).toBeGreaterThan(0);
    expect(
      fx.configuredHits.some(
        (h) =>
          h.authorization === 'Bearer secret-bearer' &&
          h['x-api-key'] === 'secret-apikey' &&
          h['x-tenant'] === 'secret-tenant',
      ),
    ).toBe(true);

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

    // PRECONDITION (as in the HTTP case): the secrets — including the dynamic
    // cfg.headers custom header — reached the legit first hop.
    expect(fx.configuredHits.length).toBeGreaterThan(0);
    expect(
      fx.configuredHits.some(
        (h) =>
          h.authorization === 'Bearer secret-bearer' &&
          h['x-api-key'] === 'secret-apikey' &&
          h['x-tenant'] === 'secret-tenant',
      ),
    ).toBe(true);

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

// The real wiring composes the redirect-safe fetch as
//   buildSafeFetch(url, Object.keys(resolveMcpHeaders(alias, cfg, env)))
// (see buildRemoteTransport in client.ts). These tests reconstruct that exact
// composition with a recording fetch so the DYNAMIC header names — including
// an operator custom header from cfg.headers — flow through the genuine
// resolver + safe-fetch plumbing, not a hand-fed allow-list.
describe('remote client safe-fetch wiring (dynamic header names)', () => {
  type Hop = { url: string; headers: Record<string, string> };

  function recordingFetch(script: Array<{ location?: string }>) {
    const hops: Hop[] = [];
    let i = 0;
    const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      hops.push({ url: url.toString(), headers });
      const step = script[i] ?? {};
      i += 1;
      if (step.location) {
        return new Response(null, { status: 307, headers: { location: step.location } });
      }
      return new Response('ok', { status: 200 });
    };
    return { impl, hops };
  }

  /** Build the safe fetch + headers exactly as buildRemoteTransport does. */
  function wire(
    cfg: Extract<McpServerConfig, { type: 'http' | 'sse' }>,
    script: Array<{ location?: string }>,
  ) {
    const url = new URL(cfg.url);
    const headers = resolveMcpHeaders('remote', cfg, {});
    const { impl, hops } = recordingFetch(script);
    const safe = buildSafeFetch(url, Object.keys(headers), impl);
    return { safe, headers, hops, url };
  }

  test('strips a dynamic cfg.headers custom header on a cross-origin redirect', async () => {
    const { safe, headers, hops } = wire(
      {
        type: 'http',
        url: 'https://mcp.example.com/v1',
        bearerToken: 'secret-bearer',
        apiKey: 'secret-apikey',
        headers: { 'X-Tenant': 'secret-tenant' },
      },
      [{ location: 'https://attacker.example.net/collect' }, {}],
    );
    await safe('https://mcp.example.com/v1', { headers });

    expect(hops).toHaveLength(2);
    // Legit first hop carried all three (proves they were attached).
    expect(hops[0]?.headers.authorization).toBe('Bearer secret-bearer');
    expect(hops[0]?.headers['x-api-key']).toBe('secret-apikey');
    expect(hops[0]?.headers['x-tenant']).toBe('secret-tenant');
    // Attacker hop carried NONE — the dynamic custom name was stripped via
    // the real Object.keys(resolveMcpHeaders(...)) plumbing.
    expect(hops[1]?.headers.authorization).toBeUndefined();
    expect(hops[1]?.headers['x-api-key']).toBeUndefined();
    expect(hops[1]?.headers['x-tenant']).toBeUndefined();
  });

  test('keeps headers on a same-host http→https UPGRADE through the real wiring', async () => {
    const { safe, headers, hops } = wire(
      {
        type: 'http',
        url: 'http://mcp.example.com/v1',
        bearerToken: 'secret-bearer',
        headers: { 'X-Tenant': 'secret-tenant' },
      },
      [{ location: 'https://mcp.example.com/v1' }, {}],
    );
    await safe('http://mcp.example.com/v1', { headers });

    expect(hops).toHaveLength(2);
    // The upgraded request still authenticates — headers survive.
    expect(hops[1]?.headers.authorization).toBe('Bearer secret-bearer');
    expect(hops[1]?.headers['x-tenant']).toBe('secret-tenant');
  });
});

describe('sanitizeConnectError', () => {
  test('surfaces a string syscall code (ENOENT) for a stdio spawn failure', () => {
    // A missing stdio binary spawns with `code: 'ENOENT'` (a STRING) — the
    // single most actionable detail for a local config, which carries no
    // secret. It must survive sanitization, not collapse to a generic class.
    const err = Object.assign(new Error('spawn fsd ENOENT'), { code: 'ENOENT' });
    expect(sanitizeConnectError(err)).toContain('ENOENT');
  });

  test('surfaces EACCES for a non-executable stdio binary', () => {
    const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    expect(sanitizeConnectError(err)).toContain('EACCES');
  });

  test('still prefers a numeric HTTP status code over a message scan', () => {
    const err = Object.assign(new Error('Unauthorized'), { code: 401 });
    expect(sanitizeConnectError(err)).toBe('HTTP 401');
  });

  test('redacts a URL / token embedded in the raw message', () => {
    // A remote transport error can embed the request URL + a token in its
    // `.message`. Sanitization must NOT echo either — only a safe class.
    const err = new Error('request to https://mcp.example.com/v1?token=super-secret-token failed');
    const out = sanitizeConnectError(err);
    expect(out).not.toContain('super-secret-token');
    expect(out).not.toContain('mcp.example.com');
    expect(out).not.toContain('https://');
  });

  test('does not surface an unrecognized string code', () => {
    // An attacker-influenced or unknown string code is NOT on the allow-list,
    // so it falls through to the safe class name rather than being echoed.
    const err = Object.assign(new Error('boom'), { code: 'SOMETHING-secret-ish' });
    expect(sanitizeConnectError(err)).not.toContain('secret');
  });
});
