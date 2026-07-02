// Phase 2 T9 — pure aggregator for routing-atom session rows.
//
// Given a list of `routing-atom`-kinded Session rows (from
// `sessionDb.listRoutingAtomsByParent` or `listRoutingAtomsAll`),
// returns a per-lane breakdown with counts, percentages, success
// rates, and durations. Pure (no side effects, no DB access); the
// `/routing-stats` command and any future surface compose this with
// their own row-fetching logic.

import type { LaneStats, RoutingStatsSnapshot } from '@yevgetman/sov-sdk/core/routingPort';
import type { Session } from '../agent/sessionDb.js';

// `LaneStats` + `RoutingStatsSnapshot` now live in open core
// (`core/routingPort.js`) so the open command contract
// (`CommandContext.getRoutingStats`) can reference them without importing this
// proprietary aggregator. Re-exported here for existing importers.
export type { LaneStats, RoutingStatsSnapshot };

/**
 * Aggregates routing-atom session rows into per-lane breakdowns.
 *
 * Success heuristic for v0: an atom is considered successful if it
 * recorded any output tokens (`outputTokens > 0`). This is a proxy
 * for "the atom produced an assistant message" — atoms that timed
 * out or errored before generating output count as failed. Atoms
 * with output tokens but no stored messages will be over-counted as
 * successes; this is acceptable for the v0 surface and will be
 * refined in Phase 2.5 once a terminal-reason store exists.
 *
 * (The plan originally specified `msgCount > 0 && totalTokens.output > 0`,
 * but `Session` rows don't carry `msgCount` — that lives on the
 * heavier `SessionListEntry` shape. Querying message counts per row
 * would require a second DB round-trip per atom; the proxy here
 * stays pure and avoids that cost.)
 *
 * Atoms whose metadata lacks a `laneName` (older rows, or rows from
 * non-router code paths that somehow leak in) bucket into `'unknown'`.
 */
export function computeRoutingStats(
  rows: readonly Session[],
  scope: 'session' | 'all' = 'session',
): RoutingStatsSnapshot {
  if (rows.length === 0) {
    return {
      scope,
      totalAtoms: 0,
      byLane: {},
      overallSuccessRate: 0,
      overallAvgDurationMs: 0,
    };
  }

  // First pass: tally counts, successes, and durations per lane.
  // Build the lane buckets immutably-by-construction (we never mutate
  // a row; the bucket map is built up once then frozen via Object.values
  // for the finalize pass).
  type Accum = {
    count: number;
    successCount: number;
    totalDurationMs: number;
  };
  const acc: Record<string, Accum> = {};
  let totalSuccess = 0;
  let totalDuration = 0;

  for (const row of rows) {
    const laneName = readLaneName(row);
    const durationMs = Math.max(0, (row.lastUpdated - row.createdAt) * 1000);
    const success = row.outputTokens > 0;

    const existing = acc[laneName] ?? { count: 0, successCount: 0, totalDurationMs: 0 };
    acc[laneName] = {
      count: existing.count + 1,
      successCount: existing.successCount + (success ? 1 : 0),
      totalDurationMs: existing.totalDurationMs + durationMs,
    };

    if (success) totalSuccess += 1;
    totalDuration += durationMs;
  }

  const totalAtoms = rows.length;

  // Finalize per-lane derived stats.
  const byLane: Record<string, LaneStats> = {};
  for (const [laneName, lane] of Object.entries(acc)) {
    byLane[laneName] = {
      count: lane.count,
      pctOfTotal: lane.count / totalAtoms,
      successCount: lane.successCount,
      successRate: lane.count > 0 ? lane.successCount / lane.count : 0,
      avgDurationMs: lane.count > 0 ? lane.totalDurationMs / lane.count : 0,
      totalDurationMs: lane.totalDurationMs,
    };
  }

  return {
    scope,
    totalAtoms,
    byLane,
    overallSuccessRate: totalSuccess / totalAtoms,
    overallAvgDurationMs: totalDuration / totalAtoms,
  };
}

function readLaneName(row: Session): string {
  const meta = row.metadata as { laneName?: unknown };
  const raw = meta.laneName;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return 'unknown';
}
