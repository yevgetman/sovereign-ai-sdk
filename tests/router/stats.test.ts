// Phase 2 T9 — tests for the pure routing-stats aggregator.
//
// The aggregator takes Session[] (routing-atom rows) and returns a
// per-lane breakdown. These tests pin the success heuristic
// (outputTokens > 0), the duration calc (lastUpdated - createdAt in
// seconds → ms), and the lane bucketing (missing laneName → 'unknown').

import { describe, expect, test } from 'bun:test';
import type { Session } from '../../src/agent/sessionDb.js';
import { computeRoutingStats } from '../../src/router/stats.js';

type MakeRowOpts = {
  laneName?: string;
  durationSec: number;
  outputTokens: number;
};

function makeRow(opts: MakeRowOpts): Session {
  const metadata: Record<string, unknown> = { kind: 'routing-atom' };
  if (opts.laneName !== undefined) metadata.laneName = opts.laneName;
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    parentSessionId: null,
    model: 'mock',
    provider: 'mock',
    platform: 'test',
    createdAt: 1000,
    lastUpdated: 1000 + opts.durationSec,
    title: 'a',
    systemPrompt: null,
    schemaVersion: 1,
    metadata,
    ownerId: null,
    inputTokens: 100,
    outputTokens: opts.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    estimatedCostUsd: 0,
    compactionInputTokens: 0,
    compactionOutputTokens: 0,
    estimatedCompactionCostUsd: 0,
  };
}

describe('computeRoutingStats', () => {
  test('empty rows return zero snapshot', () => {
    const snap = computeRoutingStats([]);
    expect(snap.scope).toBe('session');
    expect(snap.totalAtoms).toBe(0);
    expect(snap.byLane).toEqual({});
    expect(snap.overallSuccessRate).toBe(0);
    expect(snap.overallAvgDurationMs).toBe(0);
  });

  test('honors explicit scope parameter on empty input', () => {
    const snap = computeRoutingStats([], 'all');
    expect(snap.scope).toBe('all');
  });

  test('single-lane all-success returns 100% rate', () => {
    const rows = [
      makeRow({ laneName: 'cheap-task', durationSec: 1, outputTokens: 50 }),
      makeRow({ laneName: 'cheap-task', durationSec: 2, outputTokens: 100 }),
    ];
    const snap = computeRoutingStats(rows);
    expect(snap.totalAtoms).toBe(2);
    expect(snap.byLane['cheap-task']?.count).toBe(2);
    expect(snap.byLane['cheap-task']?.pctOfTotal).toBe(1);
    expect(snap.byLane['cheap-task']?.successCount).toBe(2);
    expect(snap.byLane['cheap-task']?.successRate).toBe(1);
    expect(snap.byLane['cheap-task']?.avgDurationMs).toBe(1500);
    expect(snap.byLane['cheap-task']?.totalDurationMs).toBe(3000);
    expect(snap.overallSuccessRate).toBe(1);
    expect(snap.overallAvgDurationMs).toBe(1500);
  });

  test('mixed lanes with failures compute per-lane and overall rates', () => {
    const rows = [
      // cheap-task: 1 success, 1 failure (zero output tokens)
      makeRow({ laneName: 'cheap-task', durationSec: 1, outputTokens: 10 }),
      makeRow({ laneName: 'cheap-task', durationSec: 2, outputTokens: 0 }),
      // moderate-task: 1 success
      makeRow({ laneName: 'moderate-task', durationSec: 3, outputTokens: 50 }),
    ];
    const snap = computeRoutingStats(rows);
    expect(snap.totalAtoms).toBe(3);
    expect(snap.byLane['cheap-task']?.count).toBe(2);
    expect(snap.byLane['cheap-task']?.successCount).toBe(1);
    expect(snap.byLane['cheap-task']?.successRate).toBe(0.5);
    expect(snap.byLane['cheap-task']?.pctOfTotal).toBeCloseTo(2 / 3, 5);
    expect(snap.byLane['cheap-task']?.avgDurationMs).toBe(1500);
    expect(snap.byLane['moderate-task']?.count).toBe(1);
    expect(snap.byLane['moderate-task']?.successRate).toBe(1);
    expect(snap.byLane['moderate-task']?.avgDurationMs).toBe(3000);
    expect(snap.overallSuccessRate).toBeCloseTo(2 / 3, 5);
    expect(snap.overallAvgDurationMs).toBe(2000); // (1+2+3)*1000/3
  });

  test('rows without laneName bucket into "unknown"', () => {
    const rows = [
      makeRow({ durationSec: 1, outputTokens: 10 }), // no laneName
      makeRow({ laneName: 'cheap-task', durationSec: 2, outputTokens: 20 }),
    ];
    const snap = computeRoutingStats(rows);
    expect(snap.totalAtoms).toBe(2);
    expect(snap.byLane.unknown?.count).toBe(1);
    expect(snap.byLane['cheap-task']?.count).toBe(1);
  });

  test('handles negative duration (clock skew) by clamping to zero', () => {
    // Construct a row where lastUpdated < createdAt — shouldn't happen
    // in practice but the aggregator should be defensive.
    const row = makeRow({ laneName: 'cheap-task', durationSec: 1, outputTokens: 10 });
    const skewedRow: Session = { ...row, createdAt: 2000, lastUpdated: 1000 };
    const snap = computeRoutingStats([skewedRow]);
    expect(snap.byLane['cheap-task']?.totalDurationMs).toBe(0);
    expect(snap.byLane['cheap-task']?.avgDurationMs).toBe(0);
    expect(snap.overallAvgDurationMs).toBe(0);
  });

  test('zero output tokens counts as failure even with positive duration', () => {
    const rows = [makeRow({ laneName: 'cheap-task', durationSec: 5, outputTokens: 0 })];
    const snap = computeRoutingStats(rows);
    expect(snap.byLane['cheap-task']?.successCount).toBe(0);
    expect(snap.byLane['cheap-task']?.successRate).toBe(0);
    expect(snap.overallSuccessRate).toBe(0);
  });

  test('scope label propagates onto the snapshot', () => {
    const rows = [makeRow({ laneName: 'cheap-task', durationSec: 1, outputTokens: 10 })];
    expect(computeRoutingStats(rows).scope).toBe('session');
    expect(computeRoutingStats(rows, 'all').scope).toBe('all');
  });
});
