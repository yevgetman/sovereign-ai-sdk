// Phase 10.5 part 2 — `sov eval run` CLI. Loads golden specs from a
// directory (default `evals/goldens/`), runs each against a live `sov
// chat` subprocess, scores the assertions, applies an optional budget
// from `evals/budget.json`, prints a per-golden + summary report, and
// exits non-zero on any failure.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyBudget, formatBudgetVerdict, loadBudget } from '../eval/budget.js';
import { runGolden } from '../eval/runner.js';
import type { EvalRunSummary, GoldenResult, GoldenSpec } from '../eval/types.js';

export type EvalRunOpts = {
  /** Directory holding *.golden.ts modules. Default: `evals/goldens/`. */
  goldensDir?: string;
  /** Path to a budget JSON. Default: `evals/budget.json`. */
  budgetPath?: string;
  /** Substring filter; only goldens whose id/name/category contains
   *  this run. Repeat the flag to OR multiple substrings. */
  filters?: string[];
  /** Path or name of the binary to spawn. Default: 'sov'. */
  binary?: string;
  /** Override the default 60s timeout per golden. */
  timeoutMs?: number;
  /** Include slow goldens. By default, slow:true entries are skipped. */
  includeSlow?: boolean;
  /** When true, leave each sandbox tempdir on disk for debugging. */
  keepSandbox?: boolean;
  /** Report sink. Defaults to process.stdout / process.stderr. */
  out?: (s: string) => void;
  err?: (s: string) => void;
};

export type EvalRunCliResult = {
  exitCode: number;
  summary: EvalRunSummary;
};

export async function runEvalCli(opts: EvalRunOpts = {}): Promise<EvalRunCliResult> {
  const goldensDir = resolve(opts.goldensDir ?? 'evals/goldens');
  const budgetPath = opts.budgetPath ?? 'evals/budget.json';
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));

  if (!existsSync(goldensDir)) {
    err(`eval: goldens directory not found: ${goldensDir}\n`);
    return { exitCode: 1, summary: emptySummary() };
  }

  const allGoldens = await loadGoldensFromDir(goldensDir);
  const filtered = applyFilters(allGoldens, opts.filters, opts.includeSlow ?? false);
  if (filtered.length === 0) {
    err('eval: no goldens matched filter\n');
    return { exitCode: 1, summary: emptySummary() };
  }

  out(`eval: running ${filtered.length} golden${filtered.length === 1 ? '' : 's'}\n`);

  const results: GoldenResult[] = [];
  let totalDuration = 0;
  let totalCost = 0;
  let totalToolErrors = 0;
  let passed = 0;
  let failed = 0;
  let aborted = 0;

  for (const golden of filtered) {
    out(`  · ${golden.id} `);
    const result = await runGolden(golden, {
      ...(opts.binary !== undefined ? { binary: opts.binary } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.keepSandbox === true ? { keepSandbox: true } : {}),
    });
    results.push(result);
    totalDuration += result.durationMs;
    if (result.estCostUsd !== undefined) totalCost += result.estCostUsd;
    if (result.toolCalls) totalToolErrors += result.toolCalls.err;
    if (result.abortReason) aborted++;
    if (result.pass) {
      passed++;
      out(`✓ pass (${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.estCostUsd !== undefined) out(`, $${result.estCostUsd.toFixed(3)}`);
      out(')\n');
    } else {
      failed++;
      out(`✗ fail (${(result.durationMs / 1000).toFixed(1)}s)\n`);
      for (const ar of result.assertionResults) {
        if (!ar.pass) {
          out(`        - ${ar.assertion.type}: ${ar.detail ?? '(no detail)'}\n`);
        }
      }
      if (result.abortReason) out(`        - aborted: ${result.abortReason}\n`);
    }
  }

  const summary: EvalRunSummary = {
    results,
    totals: {
      runs: results.length,
      passed,
      failed,
      aborted,
      durationMs: totalDuration,
      estCostUsd: totalCost,
      toolErrors: totalToolErrors,
    },
  };

  out('\n');
  out(
    `${results.length} golden${results.length === 1 ? '' : 's'} · ${passed} pass · ${failed} fail · ${aborted} aborted · ${(totalDuration / 1000).toFixed(1)}s · $${totalCost.toFixed(3)}\n`,
  );

  // Optional budget check.
  let budgetFailed = false;
  if (existsSync(budgetPath)) {
    const budget = loadBudget(budgetPath);
    if (budget) {
      const verdict = applyBudget(summary, budget);
      summary.budgetVerdict = verdict;
      out('\n');
      out(`${formatBudgetVerdict(verdict)}\n`);
      if (!verdict.pass) budgetFailed = true;
    }
  }

  const exitCode = failed > 0 || aborted > 0 || budgetFailed ? 1 : 0;
  return { exitCode, summary };
}

async function loadGoldensFromDir(dir: string): Promise<GoldenSpec[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.golden.ts'))
    .sort();
  const goldens: GoldenSpec[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const mod = (await import(join(dir, file))) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (!isGoldenSpec(value)) continue;
      if (seen.has(value.id)) {
        throw new Error(`duplicate golden id: ${value.id} (in ${file})`);
      }
      seen.add(value.id);
      goldens.push(value);
    }
  }
  return goldens;
}

function isGoldenSpec(value: unknown): value is GoldenSpec {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    (typeof v.prompt === 'string' || Array.isArray(v.prompt)) &&
    Array.isArray(v.assertions)
  );
}

function applyFilters(
  goldens: GoldenSpec[],
  filters: string[] | undefined,
  includeSlow: boolean,
): GoldenSpec[] {
  let out = goldens.filter((g) => includeSlow || !g.slow);
  if (filters && filters.length > 0) {
    out = out.filter((g) =>
      filters.some(
        (f) =>
          g.id.includes(f) ||
          g.name.toLowerCase().includes(f.toLowerCase()) ||
          (g.category ?? '').toLowerCase().includes(f.toLowerCase()),
      ),
    );
  }
  return out;
}

function emptySummary(): EvalRunSummary {
  return {
    results: [],
    totals: {
      runs: 0,
      passed: 0,
      failed: 0,
      aborted: 0,
      durationMs: 0,
      estCostUsd: 0,
      toolErrors: 0,
    },
  };
}
