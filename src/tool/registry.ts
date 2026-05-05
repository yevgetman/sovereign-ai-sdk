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

import { z } from 'zod';
import { AgentTool } from '../tools/AgentTool.js';
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
  AgentTool,
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
  // Phase 13.5 — patchSchemasAgainstAvailable() reads ctx.agents to
  // populate AgentTool's `subagent_type` enum with only the agents that
  // are actually loaded. When no agents are loaded (or the field is
  // absent), AgentTool is dropped from the pool entirely so the model
  // doesn't see a tool it can't successfully invoke.
  const patched = patchSchemasAgainstAvailable(withExtras, ctx);
  return [...patched].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rewrite tool input schemas that reference other tools or agents by name,
 * dropping references to anything not actually present in this pool / the
 * given context. Centralizing this here means cross-tool dependencies stay
 * in one file rather than scattering branching across the orchestrator.
 *
 * Phase 13.5: AgentTool's `subagent_type` field is rewritten from an open
 * `string` to a closed enum derived from `ctx.agents`. When no agents are
 * loaded, AgentTool is dropped from the pool so the model never sees a
 * tool it cannot successfully invoke. The enum's `describe(...)` text is
 * enriched with each agent's `description` and (when present)
 * `whenToUse` predicate — that's what the model sees in the schema every
 * turn AgentTool is in scope, so it's the strongest place to surface the
 * "when to delegate" guidance the bundle author wrote. Source of pattern:
 * Claude Code src/tools.ts (assembleToolPool + patchSchemasAgainstAvailable).
 */
export function patchSchemasAgainstAvailable(
  tools: Tool<unknown, unknown>[],
  ctx?: ToolContext,
): Tool<unknown, unknown>[] {
  const registry = ctx?.agents;
  const agentNames = registry ? [...registry.byName.keys()].sort() : [];
  if (agentNames.length === 0) {
    // Drop AgentTool entirely when there are no agents — exposing a tool
    // whose subagent_type enum is empty would let the model attempt calls
    // that always fail.
    return tools.filter((t) => t.name !== 'AgentTool');
  }
  return tools.map((t) => {
    if (t.name !== 'AgentTool') return t;
    const enumValues = agentNames as [string, ...string[]];
    const enumDescription = buildSubagentTypeDescription(agentNames, registry);
    const newSchema = z.object({
      subagent_type: z.enum(enumValues).describe(enumDescription),
      prompt: z
        .string()
        .min(1)
        .describe(
          'The task description for the sub-agent. Be specific — the agent runs as a separate session and only receives this prompt.',
        ),
    });
    return { ...t, inputSchema: newSchema as unknown as typeof t.inputSchema };
  });
}

/** Builds the `subagent_type` enum description. Lists every available
 *  agent with its description and (when present) its `whenToUse`
 *  predicate, so the model sees the trigger guidance in the schema. */
function buildSubagentTypeDescription(
  agentNames: string[],
  registry: import('../agents/types.js').AgentRegistry | undefined,
): string {
  const header =
    'The name of the loaded sub-agent to delegate to. Pick the one whose ' +
    "purpose and 'when to use' predicate best matches the current task. " +
    'Available sub-agents:';
  const agentLines = agentNames.map((name) => {
    const agent = registry?.byName.get(name);
    if (!agent) return `- ${name}`;
    const trigger =
      agent.whenToUse !== undefined && agent.whenToUse.length > 0
        ? ` Use when: ${agent.whenToUse}`
        : '';
    return `- ${name}: ${agent.description}${trigger}`;
  });
  return [header, ...agentLines].join('\n');
}
