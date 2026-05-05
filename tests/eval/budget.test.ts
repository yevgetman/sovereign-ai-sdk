// Phase 10.5 part 2 — budget enforcement tests. Covers loadBudget
// happy/missing/malformed paths, normalizeBudget validation, and
// applyBudget against synthetic run summaries.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBudget,
  formatBudgetVerdict,
  loadBudget,
  normalizeBudget,
} from '../../src/eval/budget.js';
import type { EvalRunSummary } from '../../src/eval/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sov-budget-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function summary(over: Partial<EvalRunSummary['totals']> = {}): EvalRunSummary {
  return {
    results: [],
    totals: {
      runs: 5,
      passed: 4,
      failed: 1,
      aborted: 0,
      durationMs: 60_000,
      estCostUsd: 0.5,
      toolErrors: 1,
      ...over,
    },
  };
}

describe('loadBudget', () => {
  test('returns null when the file does not exist', () => {
    expect(loadBudget(join(tmp, 'missing.json'))).toBeNull();
  });

  test('parses a valid budget file', () => {
    const path = join(tmp, 'budget.json');
    writeFileSync(
      path,
      JSON.stringify({ maxWallSeconds: 300, maxCostUsd: 1.5, minPassCount: 4 }),
      'utf8',
    );
    const budget = loadBudget(path);
    expect(budget).toEqual({ maxWallSeconds: 300, maxCostUsd: 1.5, minPassCount: 4 });
  });

  test('throws on malformed JSON with a useful detail', () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, '{not json', 'utf8');
    expect(() => loadBudget(path)).toThrow(/failed to parse budget file/);
  });
});

describe('normalizeBudget', () => {
  test('accepts an empty object', () => {
    expect(normalizeBudget({})).toEqual({});
  });

  test('rejects unknown fields', () => {
    expect(() => normalizeBudget({ maxBananas: 7 })).toThrow(/unknown field "maxBananas"/);
  });

  test('rejects non-numeric values', () => {
    expect(() => normalizeBudget({ maxCostUsd: '1.50' })).toThrow(/non-negative finite number/);
  });

  test('rejects negative values', () => {
    expect(() => normalizeBudget({ maxWallSeconds: -1 })).toThrow(/non-negative finite number/);
  });

  test('rejects NaN/Infinity', () => {
    expect(() => normalizeBudget({ maxWallSeconds: Number.POSITIVE_INFINITY })).toThrow(
      /non-negative finite number/,
    );
  });
});

describe('applyBudget', () => {
  test('passes when every threshold is satisfied', () => {
    const verdict = applyBudget(summary(), {
      maxWallSeconds: 120,
      maxCostUsd: 1.0,
      maxToolErrors: 5,
      minPassCount: 3,
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.checks).toHaveLength(4);
    expect(verdict.checks.every((c) => c.pass)).toBe(true);
  });

  test('fails when any threshold is violated', () => {
    const verdict = applyBudget(summary({ estCostUsd: 2.5 }), {
      maxCostUsd: 1.0,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.checks[0]?.actual).toBe(2.5);
    expect(verdict.checks[0]?.pass).toBe(false);
  });

  test('skips thresholds that are not declared in the budget', () => {
    const verdict = applyBudget(summary(), { maxCostUsd: 999 });
    expect(verdict.checks).toHaveLength(1);
    expect(verdict.checks[0]?.name).toBe('maxCostUsd');
  });

  test('minPassCount fails when fewer goldens passed than required', () => {
    const verdict = applyBudget(summary({ passed: 2 }), { minPassCount: 5 });
    expect(verdict.pass).toBe(false);
  });

  test('maxWallSeconds compares seconds, not ms', () => {
    const verdict = applyBudget(summary({ durationMs: 90_000 }), { maxWallSeconds: 60 });
    expect(verdict.checks[0]?.actual).toBe(90);
    expect(verdict.pass).toBe(false);
  });
});

describe('formatBudgetVerdict', () => {
  test('renders a per-check status line', () => {
    const out = formatBudgetVerdict({
      pass: false,
      checks: [
        { name: 'maxCostUsd', threshold: 1.0, actual: 2.5, pass: false },
        { name: 'minPassCount', threshold: 3, actual: 4, pass: true },
      ],
    });
    expect(out).toContain('FAIL  maxCostUsd: $2.500 / $1.000');
    expect(out).toContain('ok   minPassCount: 4 / 3');
  });
});
