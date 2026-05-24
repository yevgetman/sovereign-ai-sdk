// Phase 2 T9 — `/routing-stats` slash command.
//
// Reads the per-session (default) or cross-session (--all) routing-atom
// breakdown from CommandContext and renders a colorized table.
// The aggregator + sessionDb queries live elsewhere; this file is the
// argument-parsing + rendering shell.

import chalk from 'chalk';
import type { RoutingStatsSnapshot } from '../router/stats.js';
import type { LocalCommand } from './types.js';

export const routingStatsCommand: LocalCommand = {
  type: 'local',
  name: 'routing-stats',
  description:
    'Show per-session lane distribution + success rate + avg duration. Pass --all for cross-session stats.',
  usage: '/routing-stats [--all]',
  call: async (args, ctx) => {
    if (ctx.getRoutingStats === undefined) {
      return 'routing-stats is not wired in this surface';
    }
    const trimmed = args.trim();
    const all = trimmed === '--all';
    if (trimmed.length > 0 && !all) {
      return `usage: ${routingStatsCommand.usage}`;
    }
    const snapshot = ctx.getRoutingStats({ all });
    return renderSnapshot(snapshot);
  },
};

/** Render the snapshot as colored text. Kept module-exported so the
 *  command test can assert plain-text contents without going through
 *  the dispatcher (chalk.level=1 in tests). */
export function renderSnapshot(snap: RoutingStatsSnapshot): string {
  const lines: string[] = [];
  const scopeLabel = snap.scope === 'all' ? 'all sessions' : 'current session';
  lines.push(chalk.bold(`routing stats — ${scopeLabel}`));
  lines.push('');

  if (snap.totalAtoms === 0) {
    lines.push(chalk.gray('no routing atoms recorded.'));
    return lines.join('\n');
  }

  lines.push(`${chalk.gray('total atoms:')}        ${snap.totalAtoms}`);
  lines.push(`${chalk.gray('overall success:')}    ${formatPct(snap.overallSuccessRate)}`);
  lines.push(
    `${chalk.gray('overall avg duration:')} ${formatDurationMs(snap.overallAvgDurationMs)}`,
  );
  lines.push('');
  lines.push(chalk.bold('per-lane breakdown'));

  // Sort by count desc so the busiest lane lands first.
  const sortedLanes = Object.entries(snap.byLane).sort(([, a], [, b]) => b.count - a.count);
  const laneLabelWidth = Math.max(...sortedLanes.map(([name]) => name.length));

  for (const [laneName, stats] of sortedLanes) {
    const padded = laneName.padEnd(laneLabelWidth, ' ');
    const countLabel = `${stats.count} atom${stats.count === 1 ? '' : 's'}`;
    const pct = formatPct(stats.pctOfTotal);
    const successPct = formatPct(stats.successRate);
    const avgDur = formatDurationMs(stats.avgDurationMs);
    lines.push(
      `  ${chalk.cyan(padded)}  ${countLabel} (${pct})  ${chalk.gray('—')} ${successPct} success  ${chalk.gray('—')} ${avgDur} avg`,
    );
  }

  return lines.join('\n');
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSeconds}s`;
}
