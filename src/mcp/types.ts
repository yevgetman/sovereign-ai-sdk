// MCP client types. The runtime spawns each configured MCP server as a
// stdio subprocess at session start, discovers its tools, and wraps each
// one through the existing Tool interface (Invariant #5: one capability
// pipe). Disconnection happens at session end.
//
// HTTP/SSE/WebSocket transports are deferred (Phase 12 build plan: stdio
// covers most published servers). The pool's transport abstraction is
// the SDK's; future transports plug in without changing this file.
//
// Source of pattern: harness-build-plan.md §"Phase 12";
// claude-code-reverse-engineering.md §11. SDK: @modelcontextprotocol/sdk.

/** Settings.json shape for one MCP server. Keyed by a user-chosen alias
 *  that becomes the `mcp__<alias>__<tool>` prefix in tool names. */
export type McpServerConfig = {
  command: string;
  args?: string[] | undefined;
  /** Extra env vars merged on top of the SDK's safe-inherit defaults. */
  env?: Record<string, string> | undefined;
  /** Working directory for the spawned server. Inherits the harness cwd
   *  when unset. */
  cwd?: string | undefined;
};

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
