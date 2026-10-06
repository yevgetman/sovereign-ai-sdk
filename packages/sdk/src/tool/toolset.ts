/** Turn toolsets. An omitted toolset keeps today's assembled pool. */

import type { CanUseTool } from '../permissions/types.js';
import type { Tool } from './types.js';

export const TOOLSET_NAMES = ['chat', 'web', 'ops', 'coding'] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];

const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

const OPS_TOOLS = new Set([
  'memory',
  'skills_list',
  'skill_view',
  'task_list',
  'task_get',
  'task_output',
  'HarnessInfo',
]);

export function isToolsetName(value: string): value is ToolsetName {
  return (TOOLSET_NAMES as readonly string[]).includes(value);
}

/** Used only when the caller set a toolset and did not set `maxTurns`. */
export function defaultMaxTurns(toolset: ToolsetName): number {
  if (toolset === 'chat') return 1;
  if (toolset === 'web') return 6;
  if (toolset === 'ops') return 8;
  return 100;
}

/**
 * Keep tools the assembler already supplied. Never add a tool.
 * `coding` is a shallow copy of the pool. `chat` is empty.
 */
export function filterToolsForToolset<T extends { name: string }>(
  tools: readonly T[],
  toolset: ToolsetName,
): T[] {
  if (toolset === 'chat') return [];
  if (toolset === 'coding') return tools.slice();
  const allow = toolset === 'web' ? WEB_TOOLS : OPS_TOOLS;
  return tools.filter((tool) => allow.has(tool.name));
}

/** A skill or lane allow-list may only narrow the pool. It cannot add a name. */
export function intersectToolNames(pool: readonly string[], allow: readonly string[]): string[] {
  const allowed = new Set(allow);
  return pool.filter((name) => allowed.has(name));
}

const OUTSIDE = 'tool is outside the turn toolset';

/** Deny a call whose name is not in the filtered pool. A base decider may still deny. */
export function wrapToolsetCanUseTool(
  base: CanUseTool | undefined,
  tools: readonly { name: string }[],
): CanUseTool {
  const allowed = new Set(tools.map((tool) => tool.name));
  return async (tool: Tool<unknown, unknown>, input, ctx) => {
    if (!allowed.has(tool.name)) {
      return { behavior: 'deny', reason: OUTSIDE };
    }
    if (base) return base(tool, input, ctx);
    return { behavior: 'allow' };
  };
}
