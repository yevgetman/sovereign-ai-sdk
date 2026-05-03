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
  | 'refusal';

export interface TestSetupFile {
  /** Path relative to the test sandbox cwd. */
  path: string;
  content: string;
}

export interface TestSetup {
  /** Files materialized inside the sandbox before the binary launches. */
  files?: TestSetupFile[];
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
  /** Single user prompt sent to the agent. */
  prompt: string;
  /** Criteria the LLM judge applies to the transcript. */
  judgeCriteria: JudgeCriteria;
  /** Per-test binary timeout in ms. Default: 60_000. */
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
