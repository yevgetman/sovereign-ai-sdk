// MCP client types. At session start the runtime connects to each
// configured MCP server, discovers its tools, and wraps each one through
// the existing Tool interface (Invariant #5: one capability pipe).
// Disconnection happens at session end.
//
// Transports: stdio (a spawned subprocess), remote Streamable HTTP, and
// legacy remote SSE. The pool's transport abstraction is the SDK's, so
// each transport plugs into the same connect/list/call/shutdown surface;
// the wrapper, permission layer, and tool registry are transport-agnostic.
//
// Source of pattern: harness-build-plan.md §"Phase 12";
// claude-code-reverse-engineering.md §11. SDK: @modelcontextprotocol/sdk.

/** Settings.json shape for one MCP server. Keyed by a user-chosen alias
 *  that becomes the `mcp__<alias>__<tool>` prefix in tool names. A
 *  discriminated union over the transport `type`; legacy `{command,...}`
 *  configs (no `type`) parse as `stdio`. */
export type McpStdioServerConfig = {
  type: 'stdio';
  command: string;
  args?: string[] | undefined;
  /** Extra env vars merged on top of the SDK's safe-inherit defaults. */
  env?: Record<string, string> | undefined;
  /** Working directory for the spawned server. Inherits the harness cwd
   *  when unset. */
  cwd?: string | undefined;
};

/** Fields shared by the remote (HTTP / SSE) transports. */
export type McpRemoteServerFields = {
  /** Full endpoint URL of the remote MCP server. */
  url: string;
  /** Static headers merged onto every request. */
  headers?: Record<string, string> | undefined;
  /** Convenience: `Authorization: Bearer <token>` unless an explicit
   *  `Authorization` header is set. Prefer `SOV_MCP_<ALIAS>_TOKEN`. */
  bearerToken?: string | undefined;
  /** Convenience: `X-API-Key: <apiKey>` unless already set. Prefer
   *  `SOV_MCP_<ALIAS>_API_KEY`. */
  apiKey?: string | undefined;
};

export type McpHttpServerConfig = { type: 'http' } & McpRemoteServerFields;
export type McpSseServerConfig = { type: 'sse' } & McpRemoteServerFields;

/** Either remote (HTTP or SSE) transport. The two share `McpRemoteServerFields`
 *  (url + auth) and the same auth/redirect handling; stdio is the only other
 *  variant, so this is the natural discriminant for "is this a network
 *  server?". */
export type RemoteMcpServerConfig = McpHttpServerConfig | McpSseServerConfig;

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

/** True for the remote (HTTP / SSE) transports — the ones that read auth env,
 *  carry headers, and need redirect-safe fetch. Centralizes the
 *  `type === 'http' || type === 'sse'` discrimination that was previously
 *  hand-written at several call sites. */
export function isRemoteMcpConfig(cfg: McpServerConfig): cfg is RemoteMcpServerConfig {
  return cfg.type === 'http' || cfg.type === 'sse';
}

/** Discovered tool metadata. The `inputSchema` is opaque JSON Schema —
 *  passed verbatim to the LLM provider, used as-is in `Tool.inputJSONSchema`,
 *  and never converted to Zod (the MCP server validates inputs itself). */
export type McpToolMeta = {
  serverName: string;
  toolName: string;
  description?: string;
  /** JSON Schema object (typically `{type:'object',properties:{...}}`). */
  inputSchema: object;
};

/** A server that connected and reported its tools. Failed connections
 *  don't appear here — they're logged and skipped. */
export type McpServerHandle = {
  name: string;
  tools: McpToolMeta[];
};

/** Pool surface used by toolWrapper.ts and the server runtime.
 *  Implementations hold the live SDK clients internally. */
export type McpClientPool = {
  /** Every successfully-connected server's metadata. */
  servers(): readonly McpServerHandle[];
  /** Flat list of every discovered tool across every connected server. */
  tools(): readonly McpToolMeta[];
  /** Invoke `tool` on `server` with the given JSON-shaped input. The
   *  returned content is the SDK's CallToolResult-shape array; callers
   *  flatten it into a single string for the tool_result block. */
  call(
    serverName: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  /** Close every live transport. Idempotent; safe after a partial pool
   *  startup. */
  shutdown(): Promise<void>;
};

/** Subset of the SDK's CallToolResult that the harness uses. The SDK
 *  returns content as a discriminated union of text/image/etc. blocks;
 *  we collapse to a flat string for the tool_result content and surface
 *  `isError` so the orchestrator can mark the result accordingly. */
export type McpCallResult = {
  /** Joined textual content. Image / resource blocks render as a
   *  placeholder line so the model knows something non-text was emitted. */
  text: string;
  isError: boolean;
};
