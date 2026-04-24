// Permission-flow types — the orchestrator-level plumbing that wraps
// Tool.checkPermissions with a mode, an asker, and a session-scoped cache.
// PermissionResult itself lives in src/tool/types.ts because it's part of
// the Tool<I,O> contract; this module adds only what the orchestrator needs.

import type { PermissionResult, Tool, ToolContext } from '../tool/types.js';

/** Top-level policy for the session. Phase 3 scope — Phase 7 adds rule-based
 * modes; Phase 11 adds hook-intercept modes. */
export type PermissionMode = 'ask' | 'bypass';

/** User's response to an interactive prompt. */
export type AskResponse = 'allow' | 'always' | 'deny';

/** Human-facing prompt callback. The REPL builds one backed by its readline
 * instance; tests pass a fake. Rejection (SIGINT, closed stream) propagates
 * up and is surfaced as 'interrupted' at the turn boundary. */
export type AskUser = (opts: {
  toolName: string;
  preview: string;
  reason?: string;
  signal?: AbortSignal;
}) => Promise<AskResponse>;

/** Orchestrator-facing permission decider. Always resolves to allow or deny
 * — 'ask' is an internal state of canUseTool, never leaks out. */
export type ResolvedPermissionResult = {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  reason?: string;
};

/** The function the orchestrator calls before each tool dispatch. Phase 3
 * ignores updatedInput; Phase 7 honours it. */
export type CanUseTool = (
  tool: Tool<unknown, unknown>,
  input: unknown,
  ctx: ToolContext,
) => Promise<ResolvedPermissionResult>;

/** Convenience re-export so callers need only one import site. */
export type { PermissionResult };
