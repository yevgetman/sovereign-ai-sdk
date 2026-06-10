// Phase 10.5 part 2 — types for the golden-task evaluator. Goldens are
// declarative end-to-end tests run against a live `sov` subprocess: a
// seeded sandbox cwd, a user prompt (or sequence), and a list of code
// assertions to run after the agent quits. Distinct from the semantic
// suite (which uses an LLM judge for fuzzy scoring) — goldens use
// strict, deterministic-ish assertions.

export type FileSeedMap = Record<string, string>;

/** A declarative end-to-end golden. Each entry describes a sandbox to
 *  spin up, a prompt to drive, and assertions to evaluate after the
 *  subprocess quits. */
export type GoldenSpec = {
  /** Stable ID — also the test filter substring. */
  id: string;
  /** Short human-readable name. */
  name: string;
  /** What the test exercises. Surfaces in reports. */
  description: string;
  /** Optional category tag for grouping in reports. */
  category?: string;
  /** Files to seed into the sandbox cwd before launch. Keys are paths
   *  relative to the sandbox root. */
  seed?: FileSeedMap;
  /** Single prompt or array of prompts (one per turn). The runner pipes
   *  these into `sov drive`'s stdin and follows with `/stats` then `/quit`. */
  prompt: string | string[];
  /** Assertions to evaluate after the agent quits. All must pass for the
   *  golden to pass. */
  assertions: Assertion[];
  /** Optional per-test override for the spawn timeout. Default 60s. */
  timeoutMs?: number;
  /** Extra args appended to the `sov drive` command line (e.g.
   *  `['--permission-mode', 'bypass']`). */
  extraArgs?: string[];
  /** Optional: skip in CI / require explicit --include-slow. */
  slow?: boolean;
};

/** Discriminated union of supported assertion kinds. Every assertion is
 *  evaluated post-run against the sandbox cwd + the captured agent
 *  transcript. */
export type Assertion =
  | { type: 'fileExists'; path: string }
  | { type: 'fileNotExists'; path: string }
  | { type: 'fileContains'; path: string; text: string }
  | { type: 'fileMatches'; path: string; pattern: string; flags?: string }
  | { type: 'fileEquals'; path: string; content: string }
  | { type: 'agentResponseContains'; text: string }
  | { type: 'agentResponseMatches'; pattern: string; flags?: string }
  | { type: 'agentResponseLacks'; text: string }
  | { type: 'noToolErrors' }
  | { type: 'minToolCalls'; count: number }
  | { type: 'maxToolCalls'; count: number }
  | { type: 'exitCode'; code: number };

/** Per-assertion result. */
export type AssertionResult = {
  assertion: Assertion;
  pass: boolean;
  /** Free-form explanation when the assertion fails. */
  detail?: string;
};

/** Outcome of running one golden. Computed after the subprocess exits
 *  and assertions have been evaluated. */
export type GoldenResult = {
  id: string;
  name: string;
  /** Provider name when running in `--compare` mode; undefined for the
   *  default single-provider run. */
  provider?: string;
  pass: boolean;
  /** Wall-clock duration of the sov subprocess. */
  durationMs: number;
  /** Cost estimate parsed from the session-summary footer (USD). */
  estCostUsd?: number;
  /** Tool call counts parsed from the footer. */
  toolCalls?: { ok: number; err: number };
  /** Subprocess exit code. */
  exitCode: number;
  /** Per-assertion results in the order they were declared. */
  assertionResults: AssertionResult[];
  /** ANSI-stripped stdout transcript. Captured for failure inspection. */
  transcript: string;
  /** Captured stderr (often empty; useful for runtime warnings). */
  stderr: string;
  /** Free-form error reason when the run aborted before assertions could
   *  evaluate (timeout, spawn failure, etc.). */
  abortReason?: string;
};

/** Aggregate run summary returned by the eval runner. */
export type EvalRunSummary = {
  results: GoldenResult[];
  totals: {
    runs: number;
    passed: number;
    failed: number;
    aborted: number;
    durationMs: number;
    estCostUsd: number;
    toolErrors: number;
  };
  /** Budget verdict when a budget was supplied. */
  budgetVerdict?: BudgetVerdict;
};

/** Declarative regression budget. The runner exits non-zero when any
 *  threshold is violated. */
export type BudgetSpec = {
  /** Max total wall-clock seconds across all runs. Omit to skip. */
  maxWallSeconds?: number;
  /** Max total estimated USD cost across all runs. Omit to skip. */
  maxCostUsd?: number;
  /** Maximum total tool errors observed across all runs. Omit to skip. */
  maxToolErrors?: number;
  /** Minimum pass count out of `runs`. Useful when budget tracks a known
   *  baseline (e.g. "5 of 6 must pass"). Omit to skip. */
  minPassCount?: number;
};

export type BudgetVerdict = {
  pass: boolean;
  /** Per-threshold check results. */
  checks: BudgetCheck[];
};

export type BudgetCheck = {
  /** The threshold name (matches BudgetSpec key). */
  name: keyof BudgetSpec;
  /** Threshold value (echoed for the report). */
  threshold: number;
  /** Observed value. */
  actual: number;
  /** True when actual is within budget. */
  pass: boolean;
};
