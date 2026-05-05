// Phase 10.5 part 2 — declarative regression budget. Reads `evals/
// budget.json` (or whatever path the CLI passes) and checks the eval
// run's totals against four thresholds: maxWallSeconds, maxCostUsd,
// maxToolErrors, minPassCount. Each is opt-in (skip the field to
// disable that check).
//
// Pure: the runner aggregates totals, this module verifies them. No IO
// outside of `loadBudget()`.

import { existsSync, readFileSync } from 'node:fs';
import type { BudgetCheck, BudgetSpec, BudgetVerdict, EvalRunSummary } from './types.js';

/** Read + lightly validate a budget JSON file. Returns null when the
 *  path doesn't exist (skip-budget semantic). Throws on a malformed
 *  file so the user sees a clear error early. */
export function loadBudget(path: string): BudgetSpec | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse budget file ${path}: ${msg}`);
  }
  return normalizeBudget(raw, path);
}

/** Validate a parsed JSON object against the BudgetSpec shape. Throws
 *  on unknown fields or out-of-range values. Returns a BudgetSpec with
 *  only known fields preserved. */
export function normalizeBudget(raw: unknown, source = '<inline>'): BudgetSpec {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`budget file ${source}: expected an object, got ${typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set(['maxWallSeconds', 'maxCostUsd', 'maxToolErrors', 'minPassCount'] as const);
  const out: BudgetSpec = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!known.has(key as keyof BudgetSpec)) {
      throw new Error(`budget file ${source}: unknown field "${key}"`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `budget file ${source}: field "${key}" must be a non-negative finite number, got ${JSON.stringify(value)}`,
      );
    }
    (out as Record<string, number>)[key] = value;
  }
  return out;
}

/** Apply a budget against the run summary's totals. Returns one
 *  BudgetCheck per declared threshold + an overall pass/fail. */
export function applyBudget(summary: EvalRunSummary, budget: BudgetSpec): BudgetVerdict {
  const checks: BudgetCheck[] = [];
  if (budget.maxWallSeconds !== undefined) {
    const actual = summary.totals.durationMs / 1000;
    checks.push({
      name: 'maxWallSeconds',
      threshold: budget.maxWallSeconds,
      actual,
      pass: actual <= budget.maxWallSeconds,
    });
  }
  if (budget.maxCostUsd !== undefined) {
    checks.push({
      name: 'maxCostUsd',
      threshold: budget.maxCostUsd,
      actual: summary.totals.estCostUsd,
      pass: summary.totals.estCostUsd <= budget.maxCostUsd,
    });
  }
  if (budget.maxToolErrors !== undefined) {
    checks.push({
      name: 'maxToolErrors',
      threshold: budget.maxToolErrors,
      actual: summary.totals.toolErrors,
      pass: summary.totals.toolErrors <= budget.maxToolErrors,
    });
  }
  if (budget.minPassCount !== undefined) {
    checks.push({
      name: 'minPassCount',
      threshold: budget.minPassCount,
      actual: summary.totals.passed,
      pass: summary.totals.passed >= budget.minPassCount,
    });
  }
  return { pass: checks.every((c) => c.pass), checks };
}

export function formatBudgetVerdict(verdict: BudgetVerdict): string {
  const lines: string[] = ['budget:'];
  for (const c of verdict.checks) {
    const status = c.pass ? 'ok ' : 'FAIL';
    const actual = c.name === 'maxCostUsd' ? `$${c.actual.toFixed(3)}` : `${c.actual}`;
    const threshold = c.name === 'maxCostUsd' ? `$${c.threshold.toFixed(3)}` : `${c.threshold}`;
    lines.push(`  ${status}  ${c.name}: ${actual} / ${threshold}`);
  }
  return lines.join('\n');
}
