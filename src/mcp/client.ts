// MCP connection pool. Spawns each configured server, lists its tools,
// and exposes a uniform callTool surface to the rest of the harness.
//
// Failure model: if a server fails to start, list tools, or fails mid-
// session, we log and continue with whatever connected. One bad server
// must not take down the session — the user can fix the config and
// restart. Tool-call failures surface as `is_error: true` tool_results.
//
// The pool is session-scoped: built once, shut down on session end.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  McpCallResult,
  McpClientPool,
  McpServerConfig,
  McpServerHandle,
  McpToolMeta,
} from './types.js';

const DEFAULT_CALL_TIMEOUT_MS = 60_000;

export type BuildMcpClientPoolOpts = {
  /** Server configs keyed by alias. The alias becomes the `mcp__<alias>__`
   *  prefix on every tool name. Empty / undefined => empty pool, no spawn. */
  servers?: Record<string, McpServerConfig>;
  /** One-line console-style logger. Defaults to `process.stderr.write`. */
  log?: (msg: string) => void;
  /** Per-server connect timeout. Defaults to 15s. */
  connectTimeoutMs?: number;
};

type ActiveConnection = {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolMeta[];
};

export async function buildMcpClientPool(
  opts: BuildMcpClientPoolOpts = {},
): Promise<McpClientPool> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const servers = opts.servers ?? {};

  const active = new Map<string, ActiveConnection>();

  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const conn = await connectOne(name, cfg, connectTimeoutMs);
      active.set(name, conn);
      log(`[mcp] ${name}: ${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[mcp] ${name}: connection failed (${msg}) — disabled this session`);
    }
  }

  return {
    servers(): readonly McpServerHandle[] {
      return [...active.values()].map((c) => ({ name: c.name, tools: c.tools }));
    },
    tools(): readonly McpToolMeta[] {
      const all: McpToolMeta[] = [];
      for (const c of active.values()) all.push(...c.tools);
      return all;
    },
    async call(serverName, toolName, input, signal): Promise<McpCallResult> {
      const conn = active.get(serverName);
      if (!conn) {
        throw new Error(`mcp server not connected: ${serverName}`);
      }
      const result = await conn.client.callTool(
        {
          name: toolName,
          arguments: input as Record<string, unknown> | undefined,
        },
        undefined,
        {
          ...(signal ? { signal } : {}),
          timeout: DEFAULT_CALL_TIMEOUT_MS,
        },
      );
      // The SDK's CallToolResult is a wide union (current { content, isError }
      // form plus a legacy { toolResult } form). We accept any object shape
      // and read what's there.
      return flattenCallResult(result as unknown as ParsedCallResult);
    },
    async shutdown() {
      const errors: string[] = [];
      for (const conn of active.values()) {
        try {
          await conn.client.close();
        } catch (err) {
          errors.push(`${conn.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      active.clear();
      if (errors.length > 0) log(`[mcp] shutdown errors: ${errors.join('; ')}`);
    },
  };
}

async function connectOne(
  name: string,
  cfg: McpServerConfig,
  connectTimeoutMs: number,
): Promise<ActiveConnection> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    ...(cfg.args ? { args: cfg.args } : {}),
    ...(cfg.env ? { env: cfg.env } : {}),
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
  });

  const client = new Client({ name: 'sovereign-ai-harness', version: '0.1.0' });

  // Connect with a hard timeout — a hung subprocess must not block startup.
  await Promise.race([
    client.connect(transport),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`connect timeout after ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      ),
    ),
  ]);

  const listed = await client.listTools();
  const tools: McpToolMeta[] = listed.tools.map((t) => ({
    serverName: name,
    toolName: t.name,
    ...(t.description ? { description: t.description } : {}),
    // SDK gives us a Zod-validated object that matches MCP's JSON Schema
    // shape. Pass it through as `object` — downstream consumers (provider
    // serialization, ToolSearch) treat it opaquely.
    inputSchema: t.inputSchema as object,
  }));

  return { name, client, transport, tools };
}

type ParsedCallResult = {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }> | undefined;
  isError?: boolean | undefined;
};

function flattenCallResult(result: ParsedCallResult): McpCallResult {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push('[mcp:image content omitted]');
    } else if (block.type === 'resource') {
      parts.push('[mcp:resource content omitted]');
    } else {
      parts.push(`[mcp:${block.type} content omitted]`);
    }
  }
  return {
    text: parts.join('\n'),
    isError: result.isError === true,
  };
}
