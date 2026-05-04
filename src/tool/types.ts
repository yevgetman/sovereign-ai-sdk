// Tool<I,O,P> — the uniform capability contract. Every tool (native, MCP,
// sub-agent, skill invocation) flows through this shape.
//
// Source of pattern: Claude Code src/Tool.ts (agent-harness-design-lessons.md
// § Lesson 2 + 3). The fail-closed defaults in buildTool.ts are the load-
// bearing part — every registered tool has every method after the factory
// runs, so dispatch code never needs guards.

import type { z } from 'zod';

/** Permission outcome requested by a tool or the orchestration permission layer. */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

/** Permission decision; `updatedInput` lets checks normalize input before execution. */
export type PermissionResult = {
  behavior: PermissionBehavior;
  updatedInput?: unknown;
  reason?: string;
};

/** Result returned by optional tool-specific validation. */
export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Per-invocation runtime context passed to every tool call. */
export type ToolContext = {
  cwd: string;
  /** Bundle root when a harness bundle is loaded; absent in generic-agent mode. */
  bundleRoot?: string;
  sessionId: string;
  harnessHome?: string;
  signal?: AbortSignal;
  memoryManager?: import('../memory/provider.js').MemoryRuntime;
  subdirectoryHintState?: import('../context/subdirectoryHints.js').SubdirectoryHintState;
  skills?: import('../skills/types.js').SkillRegistry;
  activeToolNames?: string[];
  activeToolsets?: string[];
};

/** Structured tool output plus optional transcript messages injected after the result. */
export type ToolResult<T> = {
  data: T;
  /** Messages spliced into the transcript after this tool's result. Used by
   * tools that inject context (e.g. skill activation hints). Applied only
   * between serial tools; ignored for parallel batches. */
  newMessages?: import('../core/types.js').Message[];
};

/** Definition accepted by `buildTool()` before fail-closed defaults are applied. */
export type ToolDef<I, O, P = void> = {
  name: string;
  aliases?: string[];
  /** 3-10 word hint shown when the tool is deferred (see Phase 12). */
  searchHint?: string;
  description: (input: I) => Promise<string> | string;
  inputSchema: z.ZodType<I>;
  /** Raw JSON Schema (Phase 12: MCP tools). When present, the provider tools
   * array uses this verbatim and the orchestrator skips Zod input validation
   * (the underlying tool — typically an MCP server — owns input validation).
   * For native tools `inputSchema` (Zod) is the single source of truth and
   * this stays unset. */
  inputJSONSchema?: object;
  outputSchema?: z.ZodType<O>;

  /** Main execution path. */
  call: (input: I, ctx: ToolContext, onProgress?: (p: P) => void) => Promise<ToolResult<O>>;

  /** Per-tool result renderer. The orchestrator turns the tool's structured
   * output into a `tool_result` block via this when present. Without it,
   * falls back to JSON-stringification of `call()`'s `data`. Set `isError`
   * to mark the tool_result as `is_error: true` (e.g. non-zero bash exit). */
  renderResult?: (output: O) => { content: string; isError?: boolean };

  /** Path-scoped concurrency hint. Returns the absolute or cwd-relative
   * paths the call will read or write. When set, the orchestrator detects
   * overlaps within a concurrent batch and serializes a write against any
   * other access to the same path(s). Tools that don't touch the
   * filesystem (Bash with arbitrary commands, etc.) omit this. */
  affectedPaths?: (input: I) => string[];

  // Overridable; all have fail-closed defaults in buildTool().
  isEnabled?: () => boolean;
  isReadOnly?: (input: I) => boolean;
  isConcurrencySafe?: (input: I) => boolean;
  isDestructive?: (input: I) => boolean;
  checkPermissions?: (input: I, ctx: ToolContext) => Promise<PermissionResult>;
  validateInput?: (input: I, ctx: ToolContext) => Promise<ValidationResult>;

  /** Per-input pattern-matcher closure, returned by the tool. Rule engine
   * calls it without knowing the pattern semantics. */
  preparePermissionMatcher?: (input: I) => Promise<(pattern: string) => boolean>;

  /** Map this tool's input to a virtual tool name for cross-tool permission
   * resolution. E.g., `Bash("cat foo")` → `"Read"` so Read allow-rules also
   * cover read-only bash commands. Returns null when the mapping is ambiguous
   * or the command is unsafe. */
  virtualToolName?: (input: I) => string | null;

  /** Deferred tools ship as name + searchHint only, full schema fetched via
   * ToolSearchTool. Default false. */
  shouldDefer?: boolean;

  /** What happens on Ctrl-C mid-run. 'cancel' = abort cleanly; 'block' =
   * refuse to cancel. Default 'cancel'. */
  interruptBehavior?: () => 'cancel' | 'block';

  isMcp?: boolean;
  mcpInfo?: { serverName: string; toolName: string };
};

/** Fully-normalized tool contract used by registry, permissions, and orchestration. */
export type Tool<I, O, P = void> = Required<
  Pick<
    ToolDef<I, O, P>,
    | 'name'
    | 'description'
    | 'inputSchema'
    | 'call'
    | 'isEnabled'
    | 'isReadOnly'
    | 'isConcurrencySafe'
    | 'isDestructive'
    | 'checkPermissions'
    | 'interruptBehavior'
    | 'shouldDefer'
  >
> &
  Omit<
    ToolDef<I, O, P>,
    | 'isEnabled'
    | 'isReadOnly'
    | 'isConcurrencySafe'
    | 'isDestructive'
    | 'checkPermissions'
    | 'interruptBehavior'
    | 'shouldDefer'
  >;
