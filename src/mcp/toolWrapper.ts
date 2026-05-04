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
import type { Tool, ToolObservation } from '../tool/types.js';
import type { McpCallResult, McpClientPool, McpToolMeta } from './types.js';

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
      return { data: result, observation: mcpObservation(meta, result) };
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

/** Build a Phase 12.5 observation envelope from an MCP CallToolResult.
 *  The MCP server doesn't supply next_actions, so we infer a small set
 *  from common error keywords in the response text. URL-shaped lines in
 *  the response become artifacts. Best-effort — the server controls the
 *  shape and we don't pretend otherwise. */
function mcpObservation(meta: McpToolMeta, result: McpCallResult): ToolObservation {
  const summaryLine = firstNonEmptyLine(result.text) ?? `${meta.toolName} returned no text`;
  const summary = truncate(summaryLine, 120);
  const status: 'success' | 'error' = result.isError ? 'error' : 'success';
  const next_actions: string[] = [];
  if (result.isError) {
    if (/not found/i.test(result.text)) {
      next_actions.push('check the input — the resource the server looked up does not exist');
    }
    if (/unauthorized|forbidden|permission/i.test(result.text)) {
      next_actions.push("verify the server's credentials or scope");
    }
    if (/rate.?limit|too many requests/i.test(result.text)) {
      next_actions.push('wait and retry; consider batching or narrowing the request');
    }
  }
  const artifacts: string[] = [];
  for (const line of result.text.split('\n')) {
    const m = line.match(/https?:\/\/\S+/);
    if (m) {
      artifacts.push(m[0]);
      if (artifacts.length >= 5) break;
    }
  }
  return {
    status,
    summary,
    ...(next_actions.length > 0 ? { next_actions } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function firstNonEmptyLine(s: string): string | undefined {
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function makeSearchHint(meta: McpToolMeta): string {
  const base = meta.description ?? meta.toolName;
  const cleaned = base.replace(/\s+/g, ' ').trim();
  return cleaned.length > SEARCH_HINT_LIMIT
    ? `${cleaned.slice(0, SEARCH_HINT_LIMIT - 3)}...`
    : cleaned;
}
