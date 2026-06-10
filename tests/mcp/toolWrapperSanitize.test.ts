// FIX 5 — a server-supplied MCP tool name is untrusted. The composed
// `mcp__<server>__<tool>` name must satisfy the provider tool-name constraint
// (^[a-zA-Z0-9_-]{1,64}$) or EVERY subsequent provider request 400s, bricking
// the session. `wrapMcpTool` sanitizes the composed name to the allowed charset
// and length; `wrapMcpTools` additionally drops un-sanitizable tools and
// de-duplicates names that collide after sanitization.

import { describe, expect, test } from 'bun:test';
import { wrapMcpTool, wrapMcpTools } from '../../src/mcp/toolWrapper.js';
import type { McpClientPool, McpToolMeta } from '../../src/mcp/types.js';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function fakePool(): McpClientPool {
  return {
    servers: () => [],
    tools: () => [],
    async call() {
      return { text: 'ok', isError: false };
    },
    async shutdown() {},
  };
}

function meta(serverName: string, toolName: string): McpToolMeta {
  return { serverName, toolName, inputSchema: { type: 'object' } };
}

describe('wrapMcpTool — name sanitization', () => {
  test('a clean name passes through unchanged', () => {
    const tool = wrapMcpTool(meta('github', 'create_issue'), fakePool());
    expect(tool.name).toBe('mcp__github__create_issue');
    expect(NAME_RE.test(tool.name)).toBe(true);
  });

  test('a tool name with dots is sanitized to a valid name', () => {
    const tool = wrapMcpTool(meta('fs', 'a.b'), fakePool());
    expect(NAME_RE.test(tool.name)).toBe(true);
    expect(tool.name).not.toContain('.');
    // The mcp prefix + server segment are preserved so permission rules still
    // target `mcp__<server>`.
    expect(tool.name.startsWith('mcp__fs__')).toBe(true);
  });

  test('a tool name with spaces / unicode is sanitized to a valid name', () => {
    const tool = wrapMcpTool(meta('svc', 'do thing ✨'), fakePool());
    expect(NAME_RE.test(tool.name)).toBe(true);
  });

  test('a name whose composed form exceeds 64 chars is truncated to <=64', () => {
    const tool = wrapMcpTool(meta('svc', 'x'.repeat(70)), fakePool());
    expect(tool.name.length).toBeLessThanOrEqual(64);
    expect(NAME_RE.test(tool.name)).toBe(true);
    expect(tool.name.startsWith('mcp__svc__')).toBe(true);
  });

  test('mcpInfo retains the ORIGINAL server + tool names for dispatch', () => {
    // Sanitization must not break the call path: the pool is still called with
    // the server's real tool name.
    const tool = wrapMcpTool(meta('svc', 'a.b'), fakePool());
    expect(tool.mcpInfo).toEqual({ serverName: 'svc', toolName: 'a.b' });
  });
});

describe('wrapMcpTools — drop + dedupe', () => {
  test('drops a tool whose name cannot be made valid (logs a warning)', () => {
    const warnings: string[] = [];
    // A tool name of only invalid chars + an empty server → no usable segment.
    const tools = wrapMcpTools([meta('', '...')], fakePool(), (m) => warnings.push(m));
    expect(tools).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.toLowerCase()).toContain('drop');
  });

  test('keeps valid tools and de-duplicates names that collide after sanitization', () => {
    const warnings: string[] = [];
    // 'a.b' and 'a b' both sanitize to 'a_b' → composed-name collision.
    const tools = wrapMcpTools(
      [meta('svc', 'a.b'), meta('svc', 'a b'), meta('svc', 'clean')],
      fakePool(),
      (m) => warnings.push(m),
    );
    const names = tools.map((t) => t.name);
    expect(names.length).toBe(3);
    // Every name is valid and unique.
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(NAME_RE.test(n)).toBe(true);
    // The collision triggered a dedupe warning.
    expect(warnings.some((w) => w.toLowerCase().includes('dedup'))).toBe(true);
  });

  test('a fully clean set is returned unchanged with no warnings', () => {
    const warnings: string[] = [];
    const tools = wrapMcpTools(
      [meta('github', 'create_issue'), meta('github', 'list_issues')],
      fakePool(),
      (m) => warnings.push(m),
    );
    expect(tools.map((t) => t.name)).toEqual([
      'mcp__github__create_issue',
      'mcp__github__list_issues',
    ]);
    expect(warnings).toEqual([]);
  });
});
