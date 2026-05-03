// Reporter — pretty-prints semantic test progress and a final summary.
// Uses chalk (already in deps). The reporter is the only place that
// touches stdout for user-facing output; the runner returns a RunSummary
// so callers (scripts, CI) can format it however they want.

import chalk from 'chalk';
import type { JudgeVerdict, RunSummary, SemanticTest, TestResult } from './types.js';

export interface Reporter {
  start(opts: { binary: string; judgeLabel: string; tests: SemanticTest[] }): void;
  testStarted(test: SemanticTest, index: number, total: number): void;
  testFinished(result: TestResult): void;
  finished(summary: RunSummary): void;
}

export function createConsoleReporter(opts: { verbose?: boolean } = {}): Reporter {
  const verbose = opts.verbose ?? false;

  return {
    start({ binary, judgeLabel, tests }) {
      console.log(chalk.bold('\nSovereign AI — semantic test suite'));
      console.log(chalk.dim(`binary: ${binary}`));
      console.log(chalk.dim(`judge:  ${judgeLabel}`));
      console.log(chalk.dim(`tests:  ${tests.length}`));
      console.log('');
    },
    testStarted(test, index, total) {
      const tag = chalk.cyan(`[${index + 1}/${total}]`);
      const id = chalk.bold(`${test.category}.${test.id}`);
      process.stdout.write(`${tag} ${id} ${chalk.dim(test.name)}\n`);
    },
    testFinished(result) {
      const dur = (result.durationMs / 1000).toFixed(1);
      const cost = result.verdict ? `, ${formatVerdictCost(result.verdict)}` : '';
      switch (result.outcome) {
        case 'pass':
          console.log(chalk.green(`     ✓ pass (${dur}s${cost})`));
          break;
        case 'fail':
          console.log(chalk.red(`     ✗ fail (${dur}s${cost})`));
          if (result.verdict) {
            console.log(chalk.dim(`     reasoning: ${result.verdict.reasoning}`));
            if (result.verdict.failedCriteria.length) {
              console.log(chalk.dim(`     failed: ${result.verdict.failedCriteria.join(', ')}`));
            }
          }
          if (verbose && result.driver) {
            console.log(chalk.dim('     --- transcript ---'));
            for (const line of result.driver.transcript.split('\n')) {
              console.log(chalk.dim(`     ${line}`));
            }
          }
          break;
        case 'error':
          console.log(chalk.yellow(`     ! error (${dur}s) — ${result.errorMessage ?? '?'}`));
          if (verbose && result.driver) {
            console.log(chalk.dim('     --- transcript ---'));
            for (const line of result.driver.transcript.split('\n')) {
              console.log(chalk.dim(`     ${line}`));
            }
          }
          break;
        case 'skipped':
          console.log(chalk.dim('     - skipped'));
          break;
      }
    },
    finished(summary) {
      const dur = (summary.durationMs / 1000).toFixed(1);
      const passStr = chalk.green(`${summary.passed} pass`);
      const failStr =
        summary.failed > 0 ? chalk.red(`${summary.failed} fail`) : `${summary.failed} fail`;
      const errStr =
        summary.errored > 0 ? chalk.yellow(`${summary.errored} error`) : `${summary.errored} error`;
      const skipStr = summary.skipped > 0 ? ` · ${summary.skipped} skipped` : '';
      const totals = `total ${dur}s · ${formatUsd(summary.totalCostUsd)}`;
      console.log('');
      console.log(chalk.dim('─'.repeat(72)));
      console.log(
        `${summary.total} tests · ${passStr} · ${failStr} · ${errStr}${skipStr} · ${totals}`,
      );
    },
  };
}

function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatVerdictCost(verdict: JudgeVerdict): string {
  if (verdict.costUsd === 0 && verdict.backend === 'claude-code') return 'subscription';
  return formatUsd(verdict.costUsd);
}
