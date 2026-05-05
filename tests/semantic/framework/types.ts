// Semantic test types — describe one prompt-driven behavior test against a
// real harness binary (default: `sov`) and the LLM judge's verdict on the
// resulting transcript. Framework code never imports from `src/`; tests
// drive the binary as a subprocess with a fully isolated sandbox.

export type TestCategory =
  | 'tools'
  | 'commands'
  | 'permissions'
  | 'context'
  | 'workflow'
  | 'refusal'
  | 'hooks'
  | 'router'
  | 'redaction'
  | 'security';

export interface TestSetupFile {
  /** Path relative to the test sandbox cwd. */
  path: string;
  content: string;
}

export interface TestSetup {
  /** Files materialized inside the sandbox cwd before the binary launches. */
  files?: TestSetupFile[];
  /** Files materialized inside HARNESS_HOME before the binary launches.
   *  Used by the hooks suite to pre-populate the consent allowlist; non-hook
   *  tests have no need for this. Paths are relative to the sandbox's
   *  HARNESS_HOME (e.g. `shell-hooks-allowlist.json`). */
  homeFiles?: TestSetupFile[];
  /** Seed the per-sandbox user config (HARNESS_CONFIG) with this object.
   *  Default: `{}`. Used by tests that need durable settings — router
   *  block (Phase 10.6), microcompaction tuning, webSearch keys, etc. —
   *  to be active before the binary boots. */
  userConfig?: Record<string, unknown>;
  /** Additional env vars merged on top of sandbox defaults — must not collide
   *  with HARNESS_HOME / HARNESS_CONFIG / HARNESS_BUNDLE (those are owned
   *  by the sandbox). */
  env?: Record<string, string>;
  /** Free-form note shown in verbose runs. */
  notes?: string;
}

export interface JudgeCriteria {
  /** Behaviors the agent MUST demonstrate. Each is judged individually. */
  mustSatisfy: string[];
  /** Behaviors the agent MUST NOT demonstrate. Each is judged individually. */
  shouldNot?: string[];
}

export interface SemanticTest {
  /** Stable kebab-case identifier — used in reports + as a test selector. */
  id: string;
  /** Short human-readable title. */
  name: string;
  /** One sentence: what bug class does this test guard against? */
  description: string;
  category: TestCategory;
  setup?: TestSetup;
  /** Either a single user prompt (one turn) or an array of prompts (one turn
   *  per element, in order). Multi-turn tests catch coherence/memory bugs
   *  that single-shot tests can't reach. */
  prompt: string | string[];
  /** Criteria the LLM judge applies to the transcript. The judge sees the
   *  full transcript across all turns when prompt is an array. */
  judgeCriteria: JudgeCriteria;
  /** Per-test binary timeout in ms. Default: 60_000. Multi-turn tests should
   *  bump this — each turn is a model call. */
  timeoutMs?: number;
  /** Extra binary args (merged after sandbox defaults). */
  binaryArgs?: string[];
  /** Mark slow / costly tests so default runs can skip them. */
  slow?: boolean;
}

export interface DriverOutcome {
  stdout: string;
  stderr: string;
  /** Combined ANSI-stripped transcript handed to the judge. */
  transcript: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

/** Identifier for the judge backend that produced a verdict. */
export type JudgeBackend = 'claude-code' | 'anthropic-api' | (string & {});

export interface JudgeVerdict {
  pass: boolean;
  reasoning: string;
  satisfiedCriteria: string[];
  failedCriteria: string[];
  /** Approximate cost of this judge call, in USD. 0 for subscription backends. */
  costUsd: number;
  /** Tokens consumed by the judge model. (0,0) when not reported by the backend. */
  tokens: { input: number; output: number };
  /** Which backend produced this verdict. */
  backend: JudgeBackend;
}

/** A judge is just a function that turns a (test, transcript) pair into a verdict.
 *  Adding a new backend is one new file that exports a factory returning Judge. */
export type Judge = (test: SemanticTest, transcript: string) => Promise<JudgeVerdict>;

export interface TestResult {
  test: SemanticTest;
  outcome: 'pass' | 'fail' | 'error' | 'skipped';
  driver: DriverOutcome | null;
  verdict: JudgeVerdict | null;
  errorMessage?: string;
  durationMs: number;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  totalCostUsd: number;
  durationMs: number;
  results: TestResult[];
}

export interface RunnerOptions {
  /** Path to the binary under test. Default: `sov` from PATH. */
  binary?: string;
  /** Test selector (substring match against test id). */
  filter?: string;
  /** Include tests marked `slow: true`. */
  includeSlow?: boolean;
  /** If true, print full transcripts on failure. */
  verbose?: boolean;
}
