// Session-end summary card. Prints a small "powering down" report with
// session id, tool-call counts, success rate, and timing breakdown.
// Designed to mirror the goodbye summary common in coding-CLI peers.

import chalk from 'chalk';
import { boxify } from './box.js';

export type SessionMetrics = {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  agentActiveMs: number;
  apiTimeMs: number;
  toolTimeMs: number;
  toolCalls: number;
  toolOk: number;
  toolErr: number;
  /** Cumulative token usage for the session (chat + compaction lanes
   *  combined). Populated from sessionDb.getSessionCost just before the
   *  summary renders. */
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    estimatedCostUsd: number;
  };
  /** Phase 13.3 (B3) — count of review-fork dispatches that happened
   *  during the session. Rendered as a "Reviews" section when nonzero. */
  reviews?: {
    totalDispatched: number;
    byAgent: Record<string, number>;
  };
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function pct(num: number, denom: number): string {
  if (denom <= 0) return '0.0%';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function renderSessionSummary(m: SessionMetrics): string {
  const wallMs = m.endedAtMs - m.startedAtMs;
  const successRate = pct(m.toolOk, m.toolCalls);
  const apiPct = pct(m.apiTimeMs, wallMs);
  const toolPct = pct(m.toolTimeMs, wallMs);

  const body: string[] = [];
  body.push(chalk.cyan('Agent powering down. Goodbye!'));
  body.push('');
  body.push(chalk.bold('Interaction Summary'));
  body.push(`${chalk.gray('Session ID:')}    ${chalk.bold(m.sessionId)}`);
  body.push(
    `${chalk.gray('Tool Calls:')}    ${chalk.bold(String(m.toolCalls))} ${chalk.gray('(')} ${chalk.green(`✓ ${m.toolOk}`)} ${chalk.gray('·')} ${chalk.red(`✗ ${m.toolErr}`)} ${chalk.gray(')')}`,
  );
  body.push(`${chalk.gray('Success Rate:')}  ${chalk.yellow(successRate)}`);
  body.push('');
  body.push(chalk.bold('Performance'));
  body.push(`${chalk.gray('Wall Time:')}     ${chalk.bold(formatDuration(wallMs))}`);
  body.push(`${chalk.gray('Agent Active:')}  ${chalk.bold(formatDuration(m.agentActiveMs))}`);
  body.push(
    `  ${chalk.gray('» API Time:')}   ${formatDuration(m.apiTimeMs)} ${chalk.gray(`(${apiPct})`)}`,
  );
  body.push(
    `  ${chalk.gray('» Tool Time:')}  ${formatDuration(m.toolTimeMs)} ${chalk.gray(`(${toolPct})`)}`,
  );

  if (m.tokens) {
    const t = m.tokens;
    const totalIO = t.input + t.output;
    body.push('');
    body.push(chalk.bold('Tokens'));
    body.push(
      `${chalk.gray('Total:')}         ${chalk.bold(formatCount(totalIO + t.cacheRead + t.cacheWrite))}  ${chalk.gray(`(↑ ${formatCount(t.input)} · ↓ ${formatCount(t.output)})`)}`,
    );
    if (t.cacheRead > 0 || t.cacheWrite > 0) {
      body.push(
        `${chalk.gray('Cache:')}         ${chalk.gray(`read ${formatCount(t.cacheRead)} · write ${formatCount(t.cacheWrite)}`)}`,
      );
    }
    if (t.estimatedCostUsd > 0) {
      body.push(`${chalk.gray('Est. Cost:')}     ${chalk.yellow(formatUsd(t.estimatedCostUsd))}`);
    }
  }

  if (m.reviews && m.reviews.totalDispatched > 0) {
    const breakdown = Object.entries(m.reviews.byAgent)
      .filter(([, n]) => n > 0)
      .map(([agent, n]) => `${agent.replace(/^review-/, '')}=${n}`)
      .join(' · ');
    body.push('');
    body.push(chalk.bold('Reviews'));
    body.push(
      `${chalk.gray('Dispatched:')}    ${chalk.bold(String(m.reviews.totalDispatched))}  ${chalk.gray(`(${breakdown})`)}`,
    );
  }

  return ['', ...boxify(body), ''].join('\n');
}
