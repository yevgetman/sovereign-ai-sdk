import type { LaneConfig, TaskRoutingConfig } from '../config/schema.js';
import type { LaneRegistry } from '../tool/ports.js';
import { resolveLane } from './lanes.js';

// `LaneRegistry` is a pure type, relocated to open core (src/tool/ports.ts) so
// `ToolContext` can reference it without importing this proprietary router
// module. Re-exported here so existing importers (server/runtime.ts,
// router/preflight.ts) keep their path; `buildLaneRegistry` below still returns it.
export type { LaneRegistry };

/** The canonical cost-lane role names the lane registry pre-resolves. Exported
 *  so workflow validation can reject a `task.lane` that isn't one of these
 *  (an unknown lane silently routes via the agent default — a hard-to-diagnose
 *  mis-route). */
export const KNOWN_LANE_NAMES = [
  'cheap-task',
  'moderate-task',
  'frontier-task',
  'delegator',
] as const;

export function buildLaneRegistry(cfg: TaskRoutingConfig | undefined): LaneRegistry {
  const map = new Map<string, LaneConfig>();
  for (const name of KNOWN_LANE_NAMES) {
    const lane = resolveLane(name, cfg);
    if (lane !== undefined) map.set(name, lane);
  }
  return {
    lookup: (role) => map.get(role),
    entries: () => Array.from(map.entries()).map(([name, config]) => ({ name, config })),
  };
}
