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
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { VERSION } from '../version.js';
import { redactUrlAuth, resolveMcpHeaders } from './auth.js';
import { buildSafeFetch } from './safeFetch.js';
import type {
  McpCallResult,
  McpClientPool,
  McpRemoteServerFields,
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
  /** Environment map for resolving `SOV_MCP_*` auth secrets. Injected so
   *  the resolver stays pure and tests never mutate `process.env`. Defaults
   *  to `process.env` at the boundary. */
  env?: Record<string, string | undefined>;
};

type ActiveConnection = {
  name: string;
  client: Client;
  // The base SDK transport interface — concrete type is stdio / HTTP /
  // SSE depending on the server config. `shutdown` only calls
  // `client.close()`, never a transport-specific method.
  transport: Transport;
  tools: McpToolMeta[];
};

export async function buildMcpClientPool(
  opts: BuildMcpClientPoolOpts = {},
): Promise<McpClientPool> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const servers = opts.servers ?? {};
  const env = opts.env ?? process.env;

  const active = new Map<string, ActiveConnection>();

  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const conn = await connectOne(name, cfg, connectTimeoutMs, log, env);
      active.set(name, conn);
      log(`[mcp] ${name}: ${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'}`);
    } catch (err) {
      // SECURITY: a transport error from a remote server can embed the
      // request URL (query string / userinfo) or auth context. Sanitize
      // before logging — surface the alias + a redacted reason only,
      // never header values or a token-bearing URL.
      log(
        `[mcp] ${name}: connection failed (${sanitizeConnectError(err)}) — disabled this session`,
      );
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
  log: (msg: string) => void,
  env: Record<string, string | undefined>,
): Promise<ActiveConnection> {
  const transport = buildTransport(name, cfg, log, env);

  const client = new Client({ name: 'sovereign-ai-harness', version: VERSION });

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

/** Construct the SDK transport for a server config, branching on the
 *  transport `type` (defaulting to stdio for legacy configs). The
 *  returned value satisfies the base `Transport` interface; the pool
 *  only ever drives it through `client.connect()` / `client.close()`. */
function buildTransport(
  name: string,
  cfg: McpServerConfig,
  log: (msg: string) => void,
  env: Record<string, string | undefined>,
): Transport {
  if (cfg.type === 'http' || cfg.type === 'sse') {
    return buildRemoteTransport(name, cfg, log, env);
  }
  return new StdioClientTransport({
    command: cfg.command,
    ...(cfg.args ? { args: cfg.args } : {}),
    ...(cfg.env ? { env: cfg.env } : {}),
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
  });
}

function buildRemoteTransport(
  name: string,
  cfg: ({ type: 'http' } | { type: 'sse' }) & McpRemoteServerFields,
  log: (msg: string) => void,
  env: Record<string, string | undefined>,
): Transport {
  const url = new URL(cfg.url);
  warnInsecureRemoteUrl(name, url, log);
  const headers = resolveMcpHeaders(name, cfg, env);

  // SECURITY: the resolved headers carry secrets (Authorization / X-API-Key
  // / operator custom headers). Wrap fetch so a cross-origin redirect from
  // the configured server can't exfiltrate them — see safeFetch.ts. The set
  // of header names we attached is passed so ALL of them (not just the
  // always-sensitive pair) are stripped on a cross-origin hop.
  const safeFetch = buildSafeFetch(url, Object.keys(headers));

  // The remote SDK transports declare `get sessionId(): string | undefined`,
  // which trips `exactOptionalPropertyTypes` against the base `Transport`'s
  // `sessionId?: string` — a pure typing quirk; both genuinely implement
  // `Transport`. Narrow back to the interface the pool actually drives.
  if (cfg.type === 'http') {
    const t = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: safeFetch,
    });
    return t as Transport;
  }

  // Legacy SSE. Setting `eventSourceInit` suppresses the SDK's automatic
  // Authorization header, so we inject our resolved headers explicitly via
  // a fetch override on the SSE (GET) stream. The POST channel carries the
  // same headers through `requestInit` (over the same safe fetch).
  const sse = new SSEClientTransport(url, {
    requestInit: { headers },
    fetch: safeFetch,
    eventSourceInit: {
      // `init.headers` is a `Headers`-or-object whose entries are NOT
      // own-enumerable when it's a `Headers` instance — spreading it yields
      // `{}` and clobbers the SDK's `Accept: text/event-stream` +
      // `mcp-protocol-version`. Merge through `new Headers(...)` so the
      // SDK's headers survive, then layer our resolved auth on top.
      fetch: (sseUrl, init) => {
        const merged = new Headers(init.headers);
        for (const [k, v] of Object.entries(headers)) merged.set(k, v);
        return safeFetch(sseUrl, { ...init, headers: merged });
      },
    },
  });
  return sse as Transport;
}

/** Warn (never block) when a remote MCP URL is plaintext HTTP or points at
 *  a loopback / private-network host. The URL is operator-supplied config,
 *  not end-user input, so the risk is lower — but a heads-up helps catch a
 *  misconfigured production endpoint. No insecure-TLS escape hatch exists. */
function warnInsecureRemoteUrl(name: string, url: URL, log: (msg: string) => void): void {
  if (url.protocol !== 'https:') {
    log(
      `[mcp] ${name}: WARNING remote URL is not https (${redactUrlAuth(url.href)}) — traffic is unencrypted`,
    );
  }
  if (isPrivateHost(url.hostname)) {
    log(`[mcp] ${name}: note remote URL targets a private/loopback host (${url.hostname})`);
  }
}

/** Best-effort check for loopback / RFC-1918 private / link-local hosts,
 *  IPv4 and IPv6. Warn-only (kept cheap), so it deliberately does NOT
 *  attempt to decode non-dotted IPv4 encodings (decimal / octal / hex,
 *  e.g. `0x7f000001` or `2130706433`) — those are a rarer footgun and would
 *  bloat a warning heuristic; the dotted-quad scope below covers the common
 *  cases. `url.hostname` already strips the `[...]` brackets from an IPv6
 *  literal. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;

  // IPv6 (the URL parser has already stripped the surrounding brackets).
  if (host.includes(':')) return isPrivateIpv6(host);

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/** IPv6 private/loopback/link-local heuristic over the lowercased,
 *  bracket-free hostname. */
function isPrivateIpv6(host: string): boolean {
  if (host === '::1') return true; // loopback
  if (host === '::') return true; // unspecified / all-zeros
  // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded IPv4 if it's dotted;
  // otherwise flag the mapped form conservatively.
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped)) return isPrivateHost(mapped);
    return true;
  }
  // Unique local addresses fc00::/7 (fc00:: – fdff::).
  if (/^f[cd][0-9a-f]*:/.test(host)) return true;
  // Link-local fe80::/10 (fe80 – febf).
  if (/^fe[89ab][0-9a-f]*:/.test(host)) return true;
  return false;
}

/** Reduce a connect error to a secret-free, single-line reason. SDK
 *  transport errors can embed the full request URL (query / userinfo) or
 *  response bodies, so we only surface a recognized status code or a
 *  short generic class — never the raw message verbatim. */
function sanitizeConnectError(err: unknown): string {
  if (err instanceof Error) {
    // StreamableHTTPError / SseError expose a numeric `code` (HTTP status).
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return `HTTP ${code}`;
    const msg = err.message;
    if (/timeout/i.test(msg)) return 'connect timeout';
    if (/ECONNREFUSED|connection refused/i.test(msg)) return 'connection refused';
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'DNS lookup failed';
    if (/ECONNRESET/i.test(msg)) return 'connection reset';
    if (/unauthor/i.test(msg)) return 'unauthorized';
    // Fall back to the error class name, which carries no secret payload.
    return err.name || 'connect error';
  }
  return 'connect error';
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
