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

import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { AgentTool } from '@yevgetman/sov-sdk/tools/AgentTool';
import { BashTool } from '@yevgetman/sov-sdk/tools/BashTool';
import { FileEditTool } from '@yevgetman/sov-sdk/tools/FileEditTool';
import { FileReadTool } from '@yevgetman/sov-sdk/tools/FileReadTool';
import { FileWriteTool } from '@yevgetman/sov-sdk/tools/FileWriteTool';
import { GlobTool } from '@yevgetman/sov-sdk/tools/GlobTool';
import { GrepTool } from '@yevgetman/sov-sdk/tools/GrepTool';
import {
  type HarnessInfoSnapshot,
  buildHarnessInfoTool,
} from '@yevgetman/sov-sdk/tools/HarnessInfoTool';
import { MemoryTool } from '@yevgetman/sov-sdk/tools/MemoryTool';
import { SkillManageTool } from '@yevgetman/sov-sdk/tools/SkillManageTool';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';
import { SkillsListTool } from '@yevgetman/sov-sdk/tools/SkillsListTool';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';
import { StaticSiteValidateTool } from '@yevgetman/sov-sdk/tools/StaticSiteValidateTool';
import { TaskCreateTool } from '@yevgetman/sov-sdk/tools/TaskCreateTool';
import { TaskGetTool } from '@yevgetman/sov-sdk/tools/TaskGetTool';
import { TaskListTool } from '@yevgetman/sov-sdk/tools/TaskListTool';
import { TaskOutputTool } from '@yevgetman/sov-sdk/tools/TaskOutputTool';
import { TaskStopTool } from '@yevgetman/sov-sdk/tools/TaskStopTool';
import { buildToolSearchTool } from '@yevgetman/sov-sdk/tools/ToolSearchTool';
import { WebFetchTool } from '@yevgetman/sov-sdk/tools/WebFetchTool';
import { WebSearchTool } from '@yevgetman/sov-sdk/tools/WebSearchTool';
import { z } from 'zod';
import { InstinctListTool } from '../tools/InstinctListTool.js';
import { InstinctProposeTool } from '../tools/InstinctProposeTool.js';
import { InstinctUpdateConfidenceTool } from '../tools/InstinctUpdateConfidenceTool.js';
import { InstinctViewTool } from '../tools/InstinctViewTool.js';
import { MemoryProposeTool } from '../tools/MemoryProposeTool.js';
import { SkillProposeTool } from '../tools/SkillProposeTool.js';

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
  TaskCreateTool,
  TaskListTool,
  TaskGetTool,
  TaskStopTool,
  TaskOutputTool,
] as unknown as Tool<unknown, unknown>[];

/** Phase 13.3 — review-only tools that are NOT part of the main agent's
 *  pool. They live in a separate set and get injected into a review
 *  fork's parentToolPool by `runReviewFork` before scheduler.delegate(...).
 *  The scheduler's filterToolsForChild then surfaces them only for
 *  review-* agents whose allowedTools include them.
 *
 *  Why separate: the main agent doesn't need (and shouldn't be tempted
 *  by) tools that file proposals to a queue it doesn't manage. Hard
 *  enforcement at the pool level beats description-based "review
 *  sub-agents only" hints. ~530 tokens of schema budget freed.
 */
export const REVIEW_ONLY_TOOLS = [MemoryProposeTool, SkillProposeTool] as unknown as Tool<
  unknown,
  unknown
>[];

/** Phase 13.4 — learning-only tools that are NOT in the main agent's
 *  pool. Injected into the synthesizer's tool pool (Task 7) and the
 *  review fork's tool pool (Task 8) by callers via the same pattern as
 *  REVIEW_ONLY_TOOLS. The synthesizer-only writers (instinct_propose,
 *  instinct_update_confidence) are still listed here — agent-level
 *  allowedTools enforcement keeps the review fork from invoking them.
 */
export const LEARNING_ONLY_TOOLS = [
  InstinctListTool,
  InstinctViewTool,
  InstinctProposeTool,
  InstinctUpdateConfidenceTool,
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
  /** 2026-06-15 multi-agent workflows — the runtime-bound `workflow_run` tool
   *  (built lazily via a runtime holder; see buildWorkflowRunTool). When
   *  supplied it is appended so the model can trigger a named workflow
   *  mid-turn. Omitted on surfaces without a live runtime. */
  workflowRunTool?: Tool<unknown, unknown>;
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
  // Task 2.3 — pass the assembly ctx so config-gated tools (WebSearchTool reads
  // `ctx.webSearch`) decide visibility from threaded config, not an ambient read.
  const enabled = merged.filter((t) => t.isEnabled(ctx));
  // ToolSearch must see every deferred tool in the final pool — including
  // MCP tools — so its closure reads from the assembled list.
  const toolSearch = buildToolSearchTool(() =>
    enabled.filter((t) => t.shouldDefer === true),
  ) as unknown as Tool<unknown, unknown>;
  const harnessInfo = opts.harnessInfoSnapshot
    ? (buildHarnessInfoTool(opts.harnessInfoSnapshot) as unknown as Tool<unknown, unknown>)
    : null;
  const withExtras = [
    ...enabled,
    toolSearch,
    ...(harnessInfo ? [harnessInfo] : []),
    ...(opts.workflowRunTool ? [opts.workflowRunTool] : []),
  ];
  // Phase 13.5 — patchSchemasAgainstAvailable() reads ctx.agents to
  // populate AgentTool's `subagent_type` enum with only the agents that
  // are actually loaded. When no agents are loaded (or the field is
  // absent), AgentTool is dropped from the pool entirely so the model
  // doesn't see a tool it can't successfully invoke.
  const patched = patchSchemasAgainstAvailable(withExtras, ctx);
  return [...patched].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tools whose `subagent_type` field is rewritten from an open string to a
 *  closed enum at pool-assembly time. When no agents are loaded these tools
 *  are dropped entirely so the model never sees a delegation surface it
 *  cannot successfully invoke. */
const SUBAGENT_TYPE_PATCH_TOOLS = ['AgentTool', 'task_create'] as const;

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
 *
 * Phase 13.2: the same transformation is applied to `task_create`, which
 * also accepts a `subagent_type` argument (it dispatches the named agent
 * to the background TaskManager rather than the synchronous scheduler).
 * Both tools are dropped when no agents are loaded.
 */
export function patchSchemasAgainstAvailable(
  tools: Tool<unknown, unknown>[],
  ctx?: ToolContext,
): Tool<unknown, unknown>[] {
  const registry = ctx?.agents;
  const agentNames = registry ? [...registry.byName.keys()].sort() : [];
  const patchNames = new Set<string>(SUBAGENT_TYPE_PATCH_TOOLS);
  if (agentNames.length === 0) {
    // Drop the delegation tools entirely when there are no agents —
    // exposing them with an empty subagent_type enum would let the model
    // attempt calls that always fail.
    return tools.filter((t) => !patchNames.has(t.name));
  }
  const enumValues = agentNames as [string, ...string[]];
  const enumDescription = buildSubagentTypeDescription(agentNames, registry);
  return tools.map((t) => {
    if (!patchNames.has(t.name)) return t;
    return { ...t, inputSchema: rewriteSubagentTypeSchema(t, enumValues, enumDescription) };
  });
}

/** Replace the `subagent_type` field on a tool's input schema with the
 *  given closed enum, preserving every other field on the original schema
 *  (notably each tool's own `prompt` description). */
function rewriteSubagentTypeSchema(
  tool: Tool<unknown, unknown>,
  enumValues: [string, ...string[]],
  enumDescription: string,
): typeof tool.inputSchema {
  const schema = tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
  const baseShape =
    typeof schema?.shape === 'object' && schema.shape !== null
      ? (schema.shape as z.ZodRawShape)
      : ({} as z.ZodRawShape);
  const nextShape: z.ZodRawShape = {
    ...baseShape,
    subagent_type: z.enum(enumValues).describe(enumDescription),
  };
  return z.object(nextShape) as unknown as typeof tool.inputSchema;
}

/** Builds the `subagent_type` enum description. Lists every available
 *  agent with its description and (when present) its `whenToUse`
 *  predicate, so the model sees the trigger guidance in the schema. */
function buildSubagentTypeDescription(
  agentNames: string[],
  registry: import('@yevgetman/sov-sdk/agents/types').AgentRegistry | undefined,
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
