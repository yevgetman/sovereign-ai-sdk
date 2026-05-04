// MCP client pool tests. Spawn the echo-server fixture as a real
// subprocess (mirrors the bashTool / hooks runner real-subprocess
// patterns). The fixture covers happy path, isError path, and slow
// path.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildMcpClientPool } from '../../src/mcp/client.js';
import type { McpClientPool } from '../../src/mcp/types.js';

const FIXTURE = join(__dirname, 'fixtures', 'echo-server.ts');

let pool: McpClientPool;

beforeAll(async () => {
  pool = await buildMcpClientPool({
    servers: {
      echo: { command: 'bun', args: [FIXTURE] },
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
        good: { command: 'bun', args: [FIXTURE] },
        bad: { command: '/does/not/exist', args: [] },
      },
      log: (m) => logs.push(m),
      connectTimeoutMs: 2000,
    });
    expect(broken.servers().map((s) => s.name)).toEqual(['good']);
    expect(logs.some((m) => m.includes('bad') && m.includes('failed'))).toBe(true);
    await broken.shutdown();
  });
});
