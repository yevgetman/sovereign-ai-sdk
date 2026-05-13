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

/** Uniform observation envelope (Phase 12.5). Optional in v1: tools opt in by
 *  populating the field on `ToolResult`. The orchestrator renders the envelope
 *  as a structured header above the tool's own `renderResult` output, so the
 *  model sees consistent recovery and continuation signals across native, MCP,
 *  skill, and sub-agent tools. ECC's agent-harness-construction skill
 *  prescribes the {status, summary, next_actions, artifacts} shape. */
export type ToolObservation = {
  status: 'success' | 'warning' | 'error';
  /** One-line result, fits on a single screen line (ideally ≤ 80 chars). */
  summary: string;
  /** Actionable follow-ups for the agent — what to try next. Especially
   *  important on error paths so the model doesn't retry the same call. */
  next_actions?: string[];
  /** File paths, IDs, or URLs the call produced or touched. */
  artifacts?: string[];
};

/** Per-tool render-shape hint. Used by surfaces that cannot call the tool's
 *  TS `renderResult` (e.g., the Go TUI in Phase 16.1). The Go renderer
 *  dispatches on `kind`; the optional `language` is consulted by the
 *  syntax highlighter for `code` and `diff` variants. Tools that omit the
 *  field default to `{ kind: 'text' }` at the boundary. */
export type RenderHint =
  | { kind: 'text' }
  | { kind: 'markdown' }
  | { kind: 'code'; language?: string }
  | { kind: 'diff'; language?: string }
  | { kind: 'table'; columns?: string[] }
  | { kind: 'tree' }
  | { kind: 'json' };

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
  /** Phase 13 — sub-agent definitions available for delegation via AgentTool. */
  agents?: import('../agents/types.js').AgentRegistry;
  /** Phase 13.5 — sub-agent scheduler. AgentTool reads this; when absent,
   *  AgentTool throws a clear error rather than failing silently. */
  subagentScheduler?: import('../runtime/scheduler.js').SubagentScheduler;
  /** Phase 13.2 — task system manager. Tools task_create / task_list /
   *  task_get / task_stop / task_output read this. When absent, those
   *  tools throw a clear error rather than failing silently. */
  taskManager?: import('../tasks/manager.js').TaskManager;
  /** Phase 13.3 — review manager. core/query.ts calls onToolIteration after
   *  each successful tool call. ReviewManager guards by sessionId so
   *  sub-agent tool calls do not contaminate the parent's counter. */
  reviewManager?: import('../review/manager.js').ReviewManager;
  /** Phase 13.3 T11 — when true, memory_propose skips the pending queue and
   *  appends the body directly to MEMORY.md / USER.md. */
  reviewAutoPromoteMemory?: boolean;
  /** Phase 13.3 T11 — when true, skill_propose skips pending and writes
   *  SKILL.md directly to skills/agent-created/<name>/. */
  reviewAutoPromoteSkills?: boolean;
  /** Phase 13.4 — internal observation writer. Orchestrator calls
   *  ctx.learningObserver?.observe(...) after each tool call so every
   *  tool invocation lands in the per-project corpus. Fire-and-forget;
   *  never blocks the turn. */
  learningObserver?: import('../learning/observer.js').LearningObserver;
  /** Phase 13.4 follow-up (Item 19) — per-session project identity used
   *  by MemoryTool to route writes to global vs. per-project MEMORY.md.
   *  Set by terminalRepl at session boot via resolveProjectScope().
   *  Optional — when absent, MemoryTool defaults all operations to
   *  global scope. */
  projectScope?: import('../memory/scope.js').ProjectScope;
  /** Phase 13.5 — parent's full tool pool, captured at REPL bootstrap so
   *  the scheduler can filter from it without reassembling per call. */
  parentToolPool?: import('./types.js').Tool<unknown, unknown>[];
  /** Phase 13.5 — parent's permission gate. The scheduler hands it to the
   *  child's AgentRunner so the same policy applies. */
  canUseTool?: import('../permissions/types.js').CanUseTool;
  /** Phase 13.5 — parent's trace recorder. Children write into the same
   *  trace stream so post-hoc analysis sees the lineage in one place. */
  traceRecorder?: (event: import('../trace/types.js').TraceEvent) => void;
  activeToolNames?: string[];
  activeToolsets?: string[];
};

/** Structured tool output plus optional transcript messages injected after the result. */
export type ToolResult<T> = {
  data: T;
  /** Phase 12.5: optional uniform observation envelope. When present, the
   *  orchestrator prepends a structured header to the rendered `tool_result`
   *  content. `status === 'error'` also forces the tool_result `is_error`
   *  flag. Tools that omit this field render exactly as before. */
  observation?: ToolObservation;
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

  /** Hint for non-readline render surfaces (Go TUI, web). See `RenderHint`
   *  for the discriminated union. Optional; defaults to `{ kind: 'text' }`
   *  at the boundary. Phase 16.1. */
  renderHint?: RenderHint;

  /** Tool-specific compact preview of the call's input, shown next to the
   *  tool name in the REPL's compact tool slot. Without it, the REPL
   *  falls back to a generic `JSON.stringify(input)` form, which is
   *  noisy for tools whose input has many fields (FileEdit, FileRead
   *  with offset/limit, etc.). Implementations should produce a
   *  Claude-Code-style readable form like `Read(path:offset-end)`,
   *  `Edit(path)`, `Grep("pat" in path)`, etc. The result is rendered
   *  inline as `→ ToolName(<displayInput-output>)` and may be truncated
   *  by the renderer if too long. */
  displayInput?: (input: I) => string;

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
