// Pre-prompt status line. Renders a single dim line of session
// telemetry above the input frame so the user always sees where they
// are right before typing: provider/model · context % · running cost ·
// permission mode · tool count. Color-shifts the context segment
// based on the meter's zone (yellow at warn, red at danger).
//
// Why "pre-prompt status" and not a true bottom-pinned footer? A real
// always-pinned footer needs an ANSI scroll region, which is
// terminal-finicky and fights with the existing readline + bracketed
// paste setup. The pre-prompt status line gives the user the same
// "here's where I am" signal at the moment it matters — just before
// they type — without complicating the streaming output path. A
// future phase (10.5d+) can graduate to a scroll-region footer once
// the input editor lands and we control the cursor more directly.

import chalk from 'chalk';
import type { ContextMeter, ContextZone } from './contextMeter.js';

interface WritableLike {
  write(chunk: string): boolean;
}

export type FooterInfo = {
  providerName: string;
  model: string;
  bundleLabel: string | null;
  /** Permission mode label as displayed in the splash. */
  permissionMode: string;
  /** Tool count for the current scope. */
  toolCount: number;
  /** Cumulative session cost in USD (provider-reported). */
  costUsd: number;
  /** Optional context meter. When omitted, the ctx segment is hidden. */
  meter?: ContextMeter;
};

export type FooterOpts = {
  /** When false, renderFooter returns an empty string and printPreprompt
   *  is a no-op. The CLI flag and settings honor this. Default true. */
  enabled?: boolean;
};

/** Returns the rendered footer line as a single styled string (no
 *  trailing newline). Empty string when disabled. */
export function renderFooter(info: FooterInfo, opts: FooterOpts = {}): string {
  if (opts.enabled === false) return '';
  const segments: string[] = [];
  segments.push(chalk.gray(`${info.providerName} · ${info.model}`));
  if (info.meter) {
    const zone = info.meter.getZone();
    const pct = info.meter.getPercent();
    segments.push(formatContextSegment(pct, zone));
  }
  segments.push(formatCostSegment(info.costUsd));
  segments.push(chalk.gray(`perms:${info.permissionMode}`));
  segments.push(chalk.gray(`tools:${info.toolCount}`));
  if (info.bundleLabel) {
    segments.push(chalk.gray(`bundle:${info.bundleLabel}`));
  }
  return chalk.dim(segments.join(chalk.gray(' · ')));
}

/** Print the footer line followed by a single newline so it sits above
 *  the input prompt frame. Honors `enabled: false` and non-TTY by
 *  no-op. Caller is responsible for invoking this at the right moment
 *  (immediately before the prompt frame). */
export function printPrePromptFooter(
  out: WritableLike,
  info: FooterInfo,
  opts: FooterOpts = {},
): void {
  if (opts.enabled === false) return;
  if (process.stdout.isTTY === false) return;
  const line = renderFooter(info, opts);
  if (line.length === 0) return;
  out.write(`${line}\n`);
}

function formatContextSegment(pct: number, zone: ContextZone): string {
  const text = `ctx ${formatPct(pct)}`;
  if (zone === 'danger') return chalk.red(text);
  if (zone === 'warn') return chalk.yellow(text);
  return chalk.gray(text);
}

function formatPct(pct: number): string {
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

function formatCostSegment(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return chalk.gray('$0.00');
  if (costUsd < 0.01) return chalk.gray('<$0.01');
  if (costUsd < 1) return chalk.gray(`$${costUsd.toFixed(3)}`);
  return chalk.gray(`$${costUsd.toFixed(2)}`);
}
