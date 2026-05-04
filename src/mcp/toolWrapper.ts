// Wrap a discovered MCP tool through the harness's Tool interface
// (Invariant #5: every capability flows through the same pipe). The
// produced Tool participates in permissions, hooks, and orchestrator
// dispatch identically to a native tool.
//
// Naming: `mcp__<server>__<tool>`. This is the prefix that user
// permission rules match against (e.g. `mcp__github` denies the whole
// server, `mcp__github__create_issue` targets one tool).

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';
import type { McpClientPool, McpToolMeta } from './types.js';

const SEARCH_HINT_LIMIT = 80;

export function wrapMcpTool(meta: McpToolMeta, pool: McpClientPool): Tool<unknown, unknown> {
  const name = `mcp__${meta.serverName}__${meta.toolName}`;
  const description = meta.description ?? meta.toolName;
  const searchHint = makeSearchHint(meta);

  // The MCP server validates inputs itself (per its inputSchema). We use a
  // permissive Zod schema here so existing safeParse code paths in the
  // orchestrator have something to work with; the real validation happens
  // server-side and any failure flows back as an isError tool_result.
  const inputSchema = z.unknown();

  return buildTool({
    name,
    description: () => description,
    inputSchema,
    inputJSONSchema: meta.inputSchema,
    searchHint,
    shouldDefer: true,
    isMcp: true,
    mcpInfo: { serverName: meta.serverName, toolName: meta.toolName },
    async call(input, ctx) {
      const result = await pool.call(meta.serverName, meta.toolName, input, ctx.signal);
      return { data: result };
    },
    renderResult: (data) => {
      const r = data as { text: string; isError: boolean };
      return {
        content: r.text,
        ...(r.isError ? { isError: true as const } : {}),
      };
    },
  }) as unknown as Tool<unknown, unknown>;
}

function makeSearchHint(meta: McpToolMeta): string {
  const base = meta.description ?? meta.toolName;
  const cleaned = base.replace(/\s+/g, ' ').trim();
  return cleaned.length > SEARCH_HINT_LIMIT
    ? `${cleaned.slice(0, SEARCH_HINT_LIMIT - 3)}...`
    : cleaned;
}
