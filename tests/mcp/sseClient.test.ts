// Legacy-SSE remote MCP client tests. Connect the pool to an in-process
// SSE MCP server (a real `node:http` listener driven by the SDK's
// SSEServerTransport) over an actual round-trip.
//
// This is the runtime coverage that was missing in the original ship — its
// absence let the GET-stream Headers merge bug (which clobbered the SDK's
// `Accept: text/event-stream` + `mcp-protocol-version`) go undetected. The
// `preserves Accept ... AND injects Authorization` test below is the
// regression guard.

import { afterEach, describe, expect, test } from 'bun:test';
import { buildMcpClientPool } from '@yevgetman/sov-sdk/mcp/client';
import type { McpClientPool } from '@yevgetman/sov-sdk/mcp/types';
import { type SseEchoServer, startSseEchoServer } from './fixtures/sse-echo-server.js';

// The legacy-SSE client transport drives the SDK's `EventSource` over a GET
// stream. Against an in-process `node:http` fixture in the same event loop,
// Bun's `EventSource`/`node:http` interop only became reliable in Bun 1.3 —
// on the CI floor (Bun 1.2.0) the GET stream never opens and these
// round-trips hang to the test timeout. The HTTP (Streamable) transport
// tests in remoteClient.test.ts have no such dependency and run everywhere.
// The shipping runtime code is the same on every Bun; this guard only gates
// the in-process fixture round-trip to where the interop is sound. (A real
// remote SSE server over real TCP is unaffected.)
const SSE_FIXTURE_SUPPORTED = Bun.semver.satisfies(Bun.version, '>=1.3.0');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function withSse(): Promise<SseEchoServer> {
  const srv = await startSseEchoServer();
  cleanups.push(() => srv.close());
  return srv;
}

function track(pool: McpClientPool): McpClientPool {
  cleanups.push(() => pool.shutdown());
  return pool;
}

describe.skipIf(!SSE_FIXTURE_SUPPORTED)('remote MCP client pool (legacy SSE)', () => {
  test('connects, lists tools, calls a tool, surfaces isError', async () => {
    const srv = await withSse();
    const pool = track(
      await buildMcpClientPool({
        servers: { remote: { type: 'sse', url: srv.url } },
        log: () => {},
        env: {},
      }),
    );

    const servers = pool.servers();
    expect(servers).toHaveLength(1);
    const toolNames = (servers[0]?.tools ?? []).map((t) => t.toolName).sort();
    expect(toolNames).toEqual(['boom', 'echo']);

    const ok = await pool.call('remote', 'echo', { text: 'hello sse' });
    expect(ok.text).toBe('hello sse');
    expect(ok.isError).toBe(false);

    const bad = await pool.call('remote', 'boom', {});
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('something went wrong');
  }, 10_000);

  test('GET stream preserves SDK Accept: text/event-stream AND injects Authorization', async () => {
    const srv = await withSse();
    const pool = track(
      await buildMcpClientPool({
        servers: { remote: { type: 'sse', url: srv.url, bearerToken: 'sse-secret' } },
        log: () => {},
        env: {},
      }),
    );
    // A successful connect (tools listed) means the GET stream opened with
    // headers the SDK accepted.
    expect(pool.servers()).toHaveLength(1);

    // The HIGH-2 regression guard: the SDK's Accept header survived our
    // header merge, and our resolved Authorization was injected onto the
    // same GET request.
    expect(srv.seenStreamHeaders.accept).toContain('text/event-stream');
    expect(srv.seenStreamHeaders.authorization).toBe('Bearer sse-secret');
  }, 10_000);

  test('env SOV_MCP_<ALIAS>_TOKEN reaches the GET stream', async () => {
    const srv = await withSse();
    const pool = track(
      await buildMcpClientPool({
        servers: { remote: { type: 'sse', url: srv.url, bearerToken: 'cfg-secret' } },
        log: () => {},
        env: { SOV_MCP_REMOTE_TOKEN: 'env-secret' },
      }),
    );
    expect(pool.servers()).toHaveLength(1);
    expect(srv.seenStreamHeaders.authorization).toBe('Bearer env-secret');
  }, 10_000);
});
