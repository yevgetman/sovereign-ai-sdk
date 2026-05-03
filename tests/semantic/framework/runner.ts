// Runner — load test cases, execute each one inside a fresh sandbox,
// hand the transcript to the judge, aggregate results. Sequential
// execution (deterministic, easy to debug). The runner is judge-agnostic:
// it accepts a Judge function and never knows which backend produced it.
// Adding a new judge backend doesn't touch this file.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHarnessSession } from './driver.js';
import type { Reporter } from './reporter.js';
import { createSandbox } from './sandbox.js';
import type { Judge, RunSummary, RunnerOptions, SemanticTest, TestResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BINARY = 'sov';

export async function loadTestsFromDir(suitesDir: string): Promise<SemanticTest[]> {
  const files = readdirSync(suitesDir)
    .filter((f) => f.endsWith('.cases.ts'))
    .sort();
  const all: SemanticTest[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const mod = (await import(join(suitesDir, f))) as { tests?: SemanticTest[] };
    if (!Array.isArray(mod.tests)) continue;
    for (const t of mod.tests) {
      if (seen.has(t.id)) {
        throw new Error(`duplicate semantic test id: ${t.id} (in ${f})`);
      }
      seen.add(t.id);
      all.push(t);
    }
  }
  return all;
}

export interface RunSuiteOptions extends RunnerOptions {
  judge: Judge;
  judgeLabel?: string;
  reporter?: Reporter;
}

export async function runSuite(
  tests: SemanticTest[],
  options: RunSuiteOptions,
): Promise<RunSummary> {
  const binary = options.binary ?? DEFAULT_BINARY;
  const reporter = options.reporter;

  const filtered = applyFilters(tests, options);
  reporter?.start({
    binary,
    judgeLabel: options.judgeLabel ?? 'judge',
    tests: filtered,
  });

  const startedAt = performance.now();
  const results: TestResult[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const test = filtered[i];
    if (!test) continue;
    reporter?.testStarted(test, i, filtered.length);
    const result = await runOne({ test, binary, judge: options.judge });
    results.push(result);
    reporter?.testFinished(result);
  }

  const summary = summarize(results, performance.now() - startedAt, tests.length - filtered.length);
  reporter?.finished(summary);
  return summary;
}

function applyFilters(tests: SemanticTest[], opts: RunnerOptions): SemanticTest[] {
  let out = tests;
  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    out = out.filter(
      (t) =>
        t.id.toLowerCase().includes(needle) ||
        t.category.toLowerCase().includes(needle) ||
        t.name.toLowerCase().includes(needle),
    );
  }
  if (!opts.includeSlow) {
    out = out.filter((t) => !t.slow);
  }
  return out;
}

async function runOne(opts: {
  test: SemanticTest;
  binary: string;
  judge: Judge;
}): Promise<TestResult> {
  const { test, binary, judge } = opts;
  const startedAt = performance.now();
  const sandbox = createSandbox(test.setup ? { setup: test.setup } : {});
  try {
    const driver = await runHarnessSession({
      binary,
      sandbox,
      prompt: test.prompt,
      timeoutMs: test.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(test.binaryArgs ? { extraArgs: test.binaryArgs } : {}),
    });

    if (driver.timedOut) {
      return {
        test,
        outcome: 'error',
        driver,
        verdict: null,
        errorMessage: `binary timed out after ${test.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        durationMs: performance.now() - startedAt,
      };
    }
    if (driver.exitCode !== 0 && driver.exitCode !== null) {
      // Non-zero exit isn't automatically a fail — the judge still gets
      // the transcript and may decide the agent's intent was correct.
      driver.transcript = `${driver.transcript}\n--- exit code: ${driver.exitCode} ---`;
    }

    const verdict = await judge(test, driver.transcript);
    return {
      test,
      outcome: verdict.pass ? 'pass' : 'fail',
      driver,
      verdict,
      durationMs: performance.now() - startedAt,
    };
  } catch (err) {
    return {
      test,
      outcome: 'error',
      driver: null,
      verdict: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: performance.now() - startedAt,
    };
  } finally {
    sandbox.cleanup();
  }
}

function summarize(results: TestResult[], durationMs: number, skipped: number): RunSummary {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let totalCostUsd = 0;
  for (const r of results) {
    if (r.outcome === 'pass') passed++;
    else if (r.outcome === 'fail') failed++;
    else if (r.outcome === 'error') errored++;
    if (r.verdict) totalCostUsd += r.verdict.costUsd;
  }
  return {
    total: results.length,
    passed,
    failed,
    errored,
    skipped,
    totalCostUsd,
    durationMs,
    results,
  };
}
