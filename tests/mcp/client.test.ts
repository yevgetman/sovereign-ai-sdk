// MCP client pool tests. Spawn the echo-server fixture as a real
// subprocess (mirrors the bashTool / hooks runner real-subprocess
// patterns). The fixture covers happy path, isError path, and slow
// path.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildMcpClientPool, isPrivateHost } from '../../src/mcp/client.js';
import type { McpClientPool } from '../../src/mcp/types.js';

const FIXTURE = join(__dirname, 'fixtures', 'echo-server.ts');

let pool: McpClientPool;

beforeAll(async () => {
  pool = await buildMcpClientPool({
    servers: {
      echo: { type: 'stdio', command: 'bun', args: [FIXTURE] },
    },
    log: () => {},
  });
});

afterAll(async () => {
  await pool.shutdown();
});

describe('MCP client pool', () => {
  test('connected server reports its tools', () => {
    const servers = pool.servers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe('echo');
    const names = (servers[0]?.tools ?? []).map((t) => t.toolName).sort();
    expect(names).toEqual(['boom', 'echo', 'slow']);
  });

  test('flat tool list spans all servers', () => {
    const tools = pool.tools();
    expect(tools).toHaveLength(3);
    expect(tools.every((t) => t.serverName === 'echo')).toBe(true);
  });

  test('inputSchema is preserved verbatim', () => {
    const tools = pool.tools();
    const echo = tools.find((t) => t.toolName === 'echo');
    expect(echo?.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });

  test('callTool happy path returns text content', async () => {
    const result = await pool.call('echo', 'echo', { text: 'hello mcp' });
    expect(result.text).toBe('hello mcp');
    expect(result.isError).toBe(false);
  });

  test('callTool surfaces isError from the server', async () => {
    const result = await pool.call('echo', 'boom', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('something went wrong');
  });

  test('callTool throws when targeting an unknown server', async () => {
    await expect(pool.call('does-not-exist', 'echo', { text: 'x' })).rejects.toThrow(
      /not connected/,
    );
  });

  test('failed connection is logged but does not break the pool', async () => {
    const logs: string[] = [];
    const broken = await buildMcpClientPool({
      servers: {
        good: { type: 'stdio', command: 'bun', args: [FIXTURE] },
        bad: { type: 'stdio', command: '/does/not/exist', args: [] },
      },
      log: (m) => logs.push(m),
      connectTimeoutMs: 2000,
    });
    expect(broken.servers().map((s) => s.name)).toEqual(['good']);
    expect(logs.some((m) => m.includes('bad') && m.includes('failed'))).toBe(true);
    await broken.shutdown();
  });
});

describe('isPrivateHost (warn-only SSRF heuristic)', () => {
  test('flags IPv4 loopback / RFC-1918 / link-local / unspecified', () => {
    for (const h of [
      '127.0.0.1',
      '127.5.5.5',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.1.1',
      '0.0.0.0',
      'localhost',
      'svc.localhost',
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  test('flags IPv6 loopback, unspecified, ULA, link-local, and IPv4-mapped', () => {
    for (const h of [
      '::1', // loopback
      '::', // unspecified
      'fc00::1', // ULA
      'fd12:3456:789a::1', // ULA
      'fe80::1', // link-local
      'feb0::1', // link-local (upper bound)
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1', // IPv4-mapped private
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  test('does not flag public hosts', () => {
    for (const h of [
      'mcp.example.com',
      'api.githubcopilot.com',
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1', // just outside 172.16/12
      '2606:4700:4700::1111', // public IPv6 (Cloudflare)
      '::ffff:8.8.8.8', // IPv4-mapped public
    ]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});
