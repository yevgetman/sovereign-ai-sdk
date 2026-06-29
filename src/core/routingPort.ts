// src/core/routingPort.ts — open-core routing-stats DTOs.
//
// `RoutingStatsSnapshot` (and its `LaneStats` member) is the pure aggregation
// result the open command contract (`CommandContext.getRoutingStats`)
// references. Relocated here so the open contract never imports the proprietary
// `router/stats.ts` aggregator; `router/stats.ts` re-exports them, inverting the
// dependency. Pure leaves: only primitives and nested records.

/** Per-lane aggregate stats for a set of routing-atom session rows. */
export type LaneStats = {
  count: number;
  pctOfTotal: number;
  successCount: number;
  successRate: number;
  avgDurationMs: number;
  totalDurationMs: number;
};

/** Full stats snapshot returned by the aggregator. */
export type RoutingStatsSnapshot = {
  scope: 'session' | 'all';
  totalAtoms: number;
  byLane: Record<string, LaneStats>;
  overallSuccessRate: number;
  overallAvgDurationMs: number;
};
