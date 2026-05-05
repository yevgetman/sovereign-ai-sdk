// Phase 10.5 part 2b — wrap a real tool pool so that each tool.call()
// returns the next captured result for that tool. Result correlation
// is by (toolName, callIndex) — the K-th call to tool X gets the K-th
// captured result for tool X, regardless of which turn it lives in.
// The orchestrator's permission gates, hooks, schema validation, and
// concurrency partitioning all run unchanged; only the underlying
// `call()` is canned.

import type { Tool, ToolContext } from '../../tool/types.js';
import type { ReplayFixture, ReplayToolResult } from './types.js';

/** Wrap `baseTools` so each tool's `call()` returns the next captured
 *  result for that tool. Tools not present in the fixture pass through
 *  unchanged — useful when only some tools should be replayed. */
export function wrapToolsForReplay(
  baseTools: Tool<unknown, unknown>[],
  fixture: ReplayFixture,
): Tool<unknown, unknown>[] {
  const queues = buildResultQueues(fixture);
  const counters = new Map<string, number>();
  return baseTools.map((tool) => {
    const queue = queues.get(tool.name);
    if (!queue) return tool;
    const wrapped: Tool<unknown, unknown> = {
      ...tool,
      call: async (_input: unknown, _ctx: ToolContext) => {
        const idx = counters.get(tool.name) ?? 0;
        counters.set(tool.name, idx + 1);
        const result = queue[idx];
        if (!result) {
          throw new Error(
            `replay exhausted for tool ${tool.name}: agent made call #${idx} but fixture captured ${queue.length}`,
          );
        }
        if (result.error !== undefined) {
          throw new Error(result.error);
        }
        return result.observation
          ? { data: result.data, observation: result.observation }
          : { data: result.data };
      },
    };
    return wrapped;
  });
}

/** Group fixture results by tool name in observed order. The K-th
 *  result for tool X comes back in `queues.get('X')[K]`. */
function buildResultQueues(fixture: ReplayFixture): Map<string, ReplayToolResult[]> {
  const out = new Map<string, ReplayToolResult[]>();
  for (const turn of fixture.turns) {
    for (const result of turn.toolResults) {
      const list = out.get(result.toolName);
      if (list) list.push(result);
      else out.set(result.toolName, [result]);
    }
  }
  return out;
}
