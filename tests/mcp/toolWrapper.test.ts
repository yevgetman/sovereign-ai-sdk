// Wrapper tests use a fake pool — no subprocesses needed. Real-subprocess
// coverage lives in tests/mcp/client.test.ts.

import { describe, expect, test } from 'bun:test';
import {
  EAGER_MCP_TOOL_LIMIT,
  wrapMcpTool,
  wrapMcpTools,
} from '@yevgetman/sov-sdk/mcp/toolWrapper';
import type { McpClientPool, McpToolMeta } from '@yevgetman/sov-sdk/mcp/types';

function fakePool(behavior: {
  call?: (
    server: string,
    tool: string,
    input: unknown,
  ) => Promise<{ text: string; isError: boolean }>;
}): McpClientPool & { calls: Array<{ server: string; tool: string; input: unknown }> } {
  const calls: Array<{ server: string; tool: string; input: unknown }> = [];
  return {
    calls,
    servers() {
      return [];
    },
    tools() {
      return [];
    },
    async call(server, tool, input) {
      calls.push({ server, tool, input });
      return behavior.call ? behavior.call(server, tool, input) : { text: 'ok', isError: false };
    },
    async shutdown() {},
  };
}

const meta: McpToolMeta = {
  serverName: 'github',
  toolName: 'create_issue',
  description: 'Open a new GitHub issue with a title and body',
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' } },
    required: ['title'],
  },
};

const ctx = {
  cwd: process.cwd(),
  sessionId: 'test',
};

describe('wrapMcpTool', () => {
  test('produces a Tool with mcp__ prefixed name', () => {
    const pool = fakePool({});
    const tool = wrapMcpTool(meta, pool);
    expect(tool.name).toBe('mcp__github__create_issue');
  });

  test('forwards inputJSONSchema verbatim', () => {
    const pool = fakePool({});
    const tool = wrapMcpTool(meta, pool);
    expect(tool.inputJSONSchema).toEqual(meta.inputSchema);
  });

  test('defaults to deferred + carries isMcp / mcpInfo', () => {
    const pool = fakePool({});
    const tool = wrapMcpTool(meta, pool);
    expect(tool.shouldDefer).toBe(true);
    expect(tool.isMcp).toBe(true);
    expect(tool.mcpInfo).toEqual({ serverName: 'github', toolName: 'create_issue' });
  });

  test('searchHint is the description (trimmed)', () => {
    const pool = fakePool({});
    const tool = wrapMcpTool(meta, pool);
    expect(tool.searchHint).toBe('Open a new GitHub issue with a title and body');
  });

  test('searchHint truncates very long descriptions', () => {
    const longMeta: McpToolMeta = {
      ...meta,
      description: 'a'.repeat(500),
    };
    const pool = fakePool({});
    const tool = wrapMcpTool(longMeta, pool);
    expect(tool.searchHint?.length).toBeLessThanOrEqual(80);
    expect(tool.searchHint?.endsWith('...')).toBe(true);
  });

  test('searchHint falls back to tool name when no description', () => {
    const noDescMeta: McpToolMeta = {
      serverName: 'fs',
      toolName: 'read_file',
      inputSchema: { type: 'object' },
    };
    const pool = fakePool({});
    const tool = wrapMcpTool(noDescMeta, pool);
    expect(tool.searchHint).toBe('read_file');
  });

  test('call() forwards to the pool with correct server + tool name', async () => {
    const pool = fakePool({
      async call() {
        return { text: 'opened #42', isError: false };
      },
    });
    const tool = wrapMcpTool(meta, pool);
    const result = await tool.call({ title: 'Bug', body: 'broken' }, ctx);
    expect(pool.calls).toEqual([
      {
        server: 'github',
        tool: 'create_issue',
        input: { title: 'Bug', body: 'broken' },
      },
    ]);
    expect(result.data).toEqual({ text: 'opened #42', isError: false });
  });

  test('renderResult passes text through and marks isError', () => {
    const pool = fakePool({});
    const tool = wrapMcpTool(meta, pool);
    const ok = tool.renderResult?.({ text: 'fine', isError: false });
    expect(ok).toEqual({ content: 'fine' });
    const bad = tool.renderResult?.({ text: 'broke', isError: true });
    expect(bad).toEqual({ content: 'broke', isError: true });
  });
});

describe('wrapMcpTools — eager threshold (Goat Show incident, 2026-08-01)', () => {
  const mk = (n: number): McpToolMeta => ({
    serverName: 'factory-node-fs',
    toolName: `node_tool_${n}`,
    description: `tool ${n}`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  });

  test('a batch at or under EAGER_MCP_TOOL_LIMIT registers EAGERLY (shouldDefer false)', () => {
    const metas = Array.from({ length: EAGER_MCP_TOOL_LIMIT }, (_, i) => mk(i));
    const tools = wrapMcpTools(metas, fakePool({}));
    expect(tools).toHaveLength(EAGER_MCP_TOOL_LIMIT);
    for (const t of tools) {
      expect(t.shouldDefer).toBe(false);
      // Eager registration must still carry the server's real schema verbatim.
      expect(t.inputJSONSchema).toEqual(mk(0).inputSchema);
    }
  });

  test('the 7-tool node-fs conduit case is eager', () => {
    const tools = wrapMcpTools(
      Array.from({ length: 7 }, (_, i) => mk(i)),
      fakePool({}),
    );
    expect(tools.every((t) => t.shouldDefer === false)).toBe(true);
  });

  test('a batch over the limit defers every tool (prompt-cost trade preserved)', () => {
    const metas = Array.from({ length: EAGER_MCP_TOOL_LIMIT + 1 }, (_, i) => mk(i));
    const tools = wrapMcpTools(metas, fakePool({}));
    expect(tools).toHaveLength(EAGER_MCP_TOOL_LIMIT + 1);
    expect(tools.every((t) => t.shouldDefer === true)).toBe(true);
  });

  test('single-tool wrapMcpTool keeps the historical deferred default', () => {
    expect(wrapMcpTool(mk(0), fakePool({})).shouldDefer).toBe(true);
  });
});
