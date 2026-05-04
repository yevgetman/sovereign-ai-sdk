// Tool registry — assembles the per-turn tool pool. Returns every enabled
// tool, sorted by name (cache stability — the system prompt sees the same
// ordering on every turn). Phase 4: BashTool + FileRead/Write/Edit + Grep
// + Glob. Phase 12 will merge in MCP tools via the same function; Phase 9
// adds skills-as-tools; Phase 13 adds sub-agents (AgentTool). All flow
// through this one function — Invariant #5.
//
// `patchSchemasAgainstAvailable` runs unconditionally on every assembly.
// In Phase 4 it's a no-op pass; the structure is in place so Phase 12+
// tools that reference each other by name in their input schemas (e.g.
// AgentTool's `subagent_type` enum, ToolSearchTool's `tool_names` enum)
// can rewrite the dependent schemas to drop unavailable references in one
// place rather than scattering branching logic across the orchestrator.
//
// Source of pattern: Claude Code src/tools.ts (assembleToolPool +
// patchSchemasAgainstAvailable).

import { BashTool } from '../tools/BashTool.js';
import { FileEditTool } from '../tools/FileEditTool.js';
import { FileReadTool } from '../tools/FileReadTool.js';
import { FileWriteTool } from '../tools/FileWriteTool.js';
import { GlobTool } from '../tools/GlobTool.js';
import { GrepTool } from '../tools/GrepTool.js';
import { type HarnessInfoSnapshot, buildHarnessInfoTool } from '../tools/HarnessInfoTool.js';
import { MemoryTool } from '../tools/MemoryTool.js';
import { SkillManageTool } from '../tools/SkillManageTool.js';
import { SkillTool } from '../tools/SkillTool.js';
import { SkillsListTool } from '../tools/SkillsListTool.js';
import { SkillsViewTool } from '../tools/SkillsViewTool.js';
import { StaticSiteValidateTool } from '../tools/StaticSiteValidateTool.js';
import { buildToolSearchTool } from '../tools/ToolSearchTool.js';
import { WebFetchTool } from '../tools/WebFetchTool.js';
import { WebSearchTool } from '../tools/WebSearchTool.js';
import type { Tool, ToolContext } from './types.js';

const REGISTERED_TOOLS = [
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GrepTool,
  GlobTool,
  MemoryTool,
  SkillsListTool,
  SkillsViewTool,
  SkillManageTool,
  SkillTool,
  StaticSiteValidateTool,
  WebFetchTool,
  WebSearchTool,
] as unknown as Tool<unknown, unknown>[];

export type AssembleToolPoolOpts = {
  /** Phase 12: tools wrapped from connected MCP servers. Merged into the
   *  pool with native tools and sorted by name. */
  mcpTools?: Tool<unknown, unknown>[];
  /** Snapshot getter for HarnessInfo. The getter is invoked at tool-call
   *  time, so it can read the live MCP pool and the post-assembly tool
   *  pool via reference cells supplied by the REPL. When omitted, the
   *  HarnessInfo tool is not registered. */
  harnessInfoSnapshot?: () => HarnessInfoSnapshot;
};

/**
 * Return the tool pool for the current context. A new array on every call
 * so callers can safely mutate or filter. `ctx` is reserved for future
 * phases (skills filter by activation hints, permission modes hide
 * `ask`-only tools in bypass mode, etc.).
 *
 * Phase 12: ToolSearchTool is appended; its closure references the live
 * deferred-tool subset of the same pool (so newly-discovered MCP tools
 * are searchable without restarting the session).
 */
export function assembleToolPool(
  ctx: ToolContext,
  opts: AssembleToolPoolOpts = {},
): Tool<unknown, unknown>[] {
  void ctx;
  const merged: Tool<unknown, unknown>[] = [...REGISTERED_TOOLS, ...(opts.mcpTools ?? [])];
  const enabled = merged.filter((t) => t.isEnabled());
  // ToolSearch must see every deferred tool in the final pool — including
  // MCP tools — so its closure reads from the assembled list.
  const toolSearch = buildToolSearchTool(() =>
    enabled.filter((t) => t.shouldDefer === true),
  ) as unknown as Tool<unknown, unknown>;
  const harnessInfo = opts.harnessInfoSnapshot
    ? (buildHarnessInfoTool(opts.harnessInfoSnapshot) as unknown as Tool<unknown, unknown>)
    : null;
  const withExtras = [...enabled, toolSearch, ...(harnessInfo ? [harnessInfo] : [])];
  const patched = patchSchemasAgainstAvailable(withExtras);
  return [...patched].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Strip references to unavailable tools from every remaining tool's input
 * schema. Phase 4 placeholder — no current tool's input schema references
 * another tool by name, so this returns the input array unchanged. The
 * function is exported and called unconditionally so the wiring is in
 * place: Phase 12 (MCP) and Phase 13 (AgentTool with subagent_type enum)
 * are the first real users; both will mutate the relevant schema fields
 * here rather than scattering branching across the orchestrator. See
 * harness-build-plan.md § Phase 4 deepening 3.
 */
export function patchSchemasAgainstAvailable(
  tools: Tool<unknown, unknown>[],
): Tool<unknown, unknown>[] {
  return tools;
}
