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
  return ['', ...boxify(body), ''].join('\n');
}
