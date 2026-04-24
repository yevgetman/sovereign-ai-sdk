// Tool registry — assembles the per-turn tool pool. Returns every enabled
// tool, sorted by name (cache stability — the system prompt sees the same
// ordering on every turn). Phase 2: [BashTool]. Phase 12 will merge in MCP
// tools via the same function; Phase 9 adds skills-as-tools; Phase 13 adds
// sub-agents (AgentTool). All flow through this one function — Invariant #5.
//
// Source of pattern: Claude Code src/tools.ts (assembleToolPool).

import { BashTool } from '../tools/BashTool.js';
import type { Tool, ToolContext } from './types.js';

/**
 * Return the tool pool for the current context. A new array on every call
 * so callers can safely mutate or filter. `ctx` is reserved for future
 * phases (MCP tools filter by server liveness, skills filter by activation
 * hints, permission modes hide `ask`-only tools in bypass mode, etc.).
 */
export function assembleToolPool(_ctx: ToolContext): Tool<unknown, unknown>[] {
  const tools: Tool<unknown, unknown>[] = [BashTool as unknown as Tool<unknown, unknown>];
  const enabled = tools.filter((t) => t.isEnabled());
  return enabled.sort((a, b) => a.name.localeCompare(b.name));
}
