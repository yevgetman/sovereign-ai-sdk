import type { LaneConfig, TaskRoutingConfig } from '../config/schema.js';
import { resolveLane } from './lanes.js';

export type LaneRegistry = {
  lookup: (role: string) => LaneConfig | undefined;
  entries: () => Array<{ name: string; config: LaneConfig }>;
};

const KNOWN_LANES = ['cheap-task', 'moderate-task', 'frontier-task', 'delegator'] as const;

export function buildLaneRegistry(cfg: TaskRoutingConfig | undefined): LaneRegistry {
  const map = new Map<string, LaneConfig>();
  for (const name of KNOWN_LANES) {
    const lane = resolveLane(name, cfg);
    if (lane !== undefined) map.set(name, lane);
  }
  return {
    lookup: (role) => map.get(role),
    entries: () => Array.from(map.entries()).map(([name, config]) => ({ name, config })),
  };
}
