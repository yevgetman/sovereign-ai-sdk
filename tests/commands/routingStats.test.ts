// Phase 2 T9 — tests for the `/routing-stats` slash command.
//
// Drives the command through the registry (exercises dispatch wiring +
// alias resolution) and asserts the rendered output. The aggregator
// itself is unit-tested in tests/router/stats.test.ts; here we just
// pin command-level behavior: flag parsing, fallback message when
// getRoutingStats is undefined, and rendering of the snapshot.

import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import type { RoutingStatsSnapshot } from '../../src/router/stats.js';
import { makeCtx } from './_makeCtx.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

function snap(
  overrides: Partial<RoutingStatsSnapshot> = {},
  scope: 'session' | 'all' = 'session',
): RoutingStatsSnapshot {
  return {
    scope,
    totalAtoms: 0,
    byLane: {},
    overallSuccessRate: 0,
    overallAvgDurationMs: 0,
    ...overrides,
  };
}

describe('/routing-stats', () => {
  test('renders snapshot with per-lane breakdown sorted by count desc', async () => {
    const ctx = makeCtx({
      getRoutingStats: () =>
        snap({
          totalAtoms: 3,
          byLane: {
            'cheap-task': {
              count: 2,
              pctOfTotal: 2 / 3,
              successCount: 2,
              successRate: 1,
              avgDurationMs: 100,
              totalDurationMs: 200,
            },
            'moderate-task': {
              count: 1,
              pctOfTotal: 1 / 3,
              successCount: 1,
              successRate: 1,
              avgDurationMs: 200,
              totalDurationMs: 200,
            },
          },
          overallSuccessRate: 1,
          overallAvgDurationMs: 133,
        }),
    });

    const result = await dispatchSlashCommand('/routing-stats', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    const text = strip(result.output);
    expect(text).toContain('current session');
    expect(text).toContain('total atoms:');
    expect(text).toContain('3');
    expect(text).toContain('cheap-task');
    expect(text).toContain('moderate-task');
    expect(text).toContain('66.7%');
    expect(text).toContain('33.3%');
    expect(text).toContain('100.0% success');
    // cheap-task (count 2) sorts before moderate-task (count 1)
    const cheapIdx = text.indexOf('cheap-task');
    const moderateIdx = text.indexOf('moderate-task');
    expect(cheapIdx).toBeGreaterThan(0);
    expect(moderateIdx).toBeGreaterThan(cheapIdx);
  });

  test('passes --all flag through to getRoutingStats', async () => {
    let capturedOpts: { all?: boolean } | undefined;
    const ctx = makeCtx({
      getRoutingStats: (opts) => {
        capturedOpts = opts;
        return snap({}, 'all');
      },
    });
    const result = await dispatchSlashCommand('/routing-stats --all', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(capturedOpts?.all).toBe(true);
    expect(strip(result.output)).toContain('all sessions');
  });

  test('default invocation passes all:false', async () => {
    let capturedOpts: { all?: boolean } | undefined;
    const ctx = makeCtx({
      getRoutingStats: (opts) => {
        capturedOpts = opts;
        return snap();
      },
    });
    await dispatchSlashCommand('/routing-stats', ctx);
    expect(capturedOpts?.all).toBe(false);
  });

  test('zero atoms renders friendly empty message', async () => {
    const ctx = makeCtx({ getRoutingStats: () => snap() });
    const result = await dispatchSlashCommand('/routing-stats', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('no routing atoms recorded.');
  });

  test('missing getRoutingStats yields a fallback message', async () => {
    const ctx = makeCtx(); // no getRoutingStats override → undefined
    const result = await dispatchSlashCommand('/routing-stats', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('not wired');
  });

  test('unknown args reject with usage hint', async () => {
    const ctx = makeCtx({ getRoutingStats: () => snap() });
    const result = await dispatchSlashCommand('/routing-stats --bogus', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('/routing-stats');
  });

  test('formats sub-second average duration as ms', async () => {
    const ctx = makeCtx({
      getRoutingStats: () =>
        snap({
          totalAtoms: 1,
          byLane: {
            'cheap-task': {
              count: 1,
              pctOfTotal: 1,
              successCount: 1,
              successRate: 1,
              avgDurationMs: 250,
              totalDurationMs: 250,
            },
          },
          overallSuccessRate: 1,
          overallAvgDurationMs: 250,
        }),
    });
    const result = await dispatchSlashCommand('/routing-stats', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(strip(result.output)).toContain('250ms');
  });
});
