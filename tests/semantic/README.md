# Semantic test suite

LLM-judged behavior tests that drive the real `sov` binary as a subprocess and
verify it behaves correctly. Complements (does not replace) the unit/integration
suites under `tests/`.

This README is the developer-facing reference: architecture, isolation, layout,
how to add a test, how to add a judge backend, porting guide. For the canonical
inventory of which tests exist and what each one guards against, see
[`docs/06-testing/semantic-testing.md`](../../docs/06-testing/semantic-testing.md) at the repo root.

## What problem this solves

Unit tests catch logic bugs in isolated functions. They cannot catch:

- "The Bash tool runs but the agent doesn't surface the output."
- "The agent hallucinates file contents when Read returns an error."
- "Slash command dispatch breaks when piped from stdin."
- "A streaming corruption regression makes the response unreadable."

Each test sends one prompt to `sov`, captures the transcript, and asks an LLM
judge whether the agent's behavior matched a list of must-satisfy / should-not
criteria. The criteria are designed per-test to target a specific bug class.

## Isolation guarantees

This suite is **strictly additive** — running it cannot affect the harness
codebase, your config, or any other tests. Concretely:

- Every test gets a fresh `mktemp -d` for its working directory, plus its
  own `HARNESS_HOME`, `HARNESS_CONFIG`, sessions DB, and config file. The
  entire root tempdir is removed when the test finishes (success, failure,
  or crash).
- The framework spawns `sov` as a subprocess. It never `import`s anything
  from `src/`. Replacing `sov` with another binary is a config change, not
  a code change.
- The judge subprocess (when using `claude-code`) runs in `os.tmpdir()`
  with `--tools ""`, `--no-session-persistence`, and
  `--disable-slash-commands`. It cannot touch the repo or persist state.
- Test files match `*.cases.ts`, not `*.test.ts` — Bun's default test
  runner does not pick them up. `bun test` continues to run only the
  existing unit/integration suite.
- No new production dependencies. `@anthropic-ai/sdk` (api judge) and
  `chalk` (reporter) are already in `package.json`.

## Judge backends

The judge is pluggable. Pick one with `--judge <name>`:

| Name | Cost | How it works |
|---|---|---|
| `claude-code` (default) | Your subscription — no API tokens | Shells out to local `claude` CLI in `--print` mode with `--json-schema` for structured output. Uses your authenticated session. |
| `anthropic-api` | API tokens | Direct `@anthropic-ai/sdk` call with tool-use. Needs `ANTHROPIC_API_KEY`. Useful for CI runners without `claude` installed. |
| `auto` | — | Prefer `claude-code` if `claude` is on `PATH`, else fall back to `anthropic-api`. |

Default behavior: if you have `claude` installed (which most contributors do
since the harness is Claude-Code-style), the suite uses your subscription.
You spend zero API tokens by default.

## Running

```bash
# Run the full suite (auto-picks claude-code if available; no API tokens needed)
bun run test:semantic

# Filter by id, name, or category
bun run test:semantic -- --filter bash

# List discovered tests without running anything
bun run test:semantic -- --list

# Verbose mode prints the transcript on failure
bun run test:semantic -- --verbose

# Force the API judge (requires ANTHROPIC_API_KEY)
bun run test:semantic -- --judge anthropic-api

# Pin a specific judge model
bun run test:semantic -- --judge-model claude-sonnet-4-6

# Use a different binary under test
SEMANTIC_BINARY=./build/sov bun run test:semantic
```

This suite is **not** part of `bun test` — it is opt-in because each test
spawns a real model turn (which spends credit/tokens regardless of judge
backend, since the binary itself is talking to a model). CI integration is
left to the embedding project.

## Layout

```
tests/semantic/
├── framework/
│   ├── types.ts                 SemanticTest, JudgeVerdict, Judge, RunSummary
│   ├── sandbox.ts               Per-test ephemeral env + filesystem
│   ├── driver.ts                Spawn the binary, pipe prompt, capture transcript
│   ├── judges/
│   │   ├── index.ts             Backend selection + auto-detection
│   │   ├── prompt.ts            Shared prompt builder + verdict parser
│   │   ├── claudeCode.ts        Default backend — shells out to `claude` CLI
│   │   └── anthropicApi.ts      Opt-in backend — direct API call
│   ├── reporter.ts              Console output (colored progress + summary)
│   └── runner.ts                Load cases, orchestrate, aggregate
├── suites/
│   ├── 01-tools.cases.ts          Bash, Read, Edit, Write — happy paths + error reporting
│   ├── 02-commands.cases.ts       Slash command dispatch (/help, /commit, /init, /context-budget, /skill)
│   ├── 03-workflow.cases.ts       Multi-step + simple context + refusal-on-missing
│   ├── 04-permissions.cases.ts    Deny / allow / deny-wins / bypass-honors-deny / virtual-tool / layer-precedence
│   ├── 05-search.cases.ts         Glob, Grep
│   ├── 06-context.cases.ts        @file expansion
│   ├── 07-refusal.cases.ts        Zero-results, prompt-injection, verify-not-trust-user
│   ├── 08-multi-turn.cases.ts     Cross-turn memory, refinement, error-recovery, /compact, /rollback
│   ├── 09-skills.cases.ts         Markdown-skill invocation via .harness/skills/
│   ├── 10-hooks.cases.ts          PreToolUse + PostToolUse hooks (Phase 11)
│   ├── 11-mcp.cases.ts            MCP discovery + invocation + permission denial (Phase 12)
│   ├── 12-harness-info.cases.ts   HarnessInfo + self-doc segment (Phase 12.7)
│   └── 13-router.cases.ts         --provider router end-to-end (Phase 10.6)
├── run.ts                        Entry point
└── README.md                     This file
```

## Adding a new test

1. Pick (or add) a file under `suites/` named `NN-topic.cases.ts`.
2. Append an entry to its `tests` array:

```ts
{
  id: 'kebab-case-id',           // unique across the whole suite
  name: 'Short human title',
  description: 'Which bug class does this test guard against?',
  category: 'tools' | 'commands' | 'permissions' | 'context' | 'workflow' | 'refusal' | 'hooks' | 'router' | 'redaction' | 'security',
  setup: {
    files: [{ path: 'foo.txt', content: 'bar' }],   // optional
    homeFiles: [{ path: 'config.json', content: '{}' }],  // optional, written under HARNESS_HOME
    userConfig: { router: { localProvider: 'anthropic' } },  // optional, overrides HARNESS_CONFIG (Phase 10.6)
    env: { CUSTOM_VAR: 'value' },  // optional, merged on top of sandbox defaults
  },
  // Single string for one turn, or string[] for multi-turn (one prompt per turn).
  prompt: 'The single user prompt sent to the agent.',
  judgeCriteria: {
    mustSatisfy: [
      'A behavior the transcript MUST demonstrate.',
      'Another required behavior.',
    ],
    shouldNot: [
      'A behavior that, if observed, forces fail.',
    ],
  },
  timeoutMs: 45_000,             // default 60_000; bump for multi-turn (90-120s)
  slow: false,                   // default false; set true to skip in default runs
}
```

Multi-turn example:

```ts
{
  id: 'cross-turn-memory',
  category: 'workflow',
  prompt: [
    'Remember this token for my next question: alpha-beta-9k2x.',
    'What was the token I asked you to remember?',
  ],
  judgeCriteria: {
    mustSatisfy: [
      'In response to Turn 2, the agent correctly recalls "alpha-beta-9k2x".',
    ],
  },
  timeoutMs: 90_000,
}
```

The driver pipes each prompt to stdin separated by newlines, terminated with `/quit`.
`sov`'s queued-question pattern consumes them sequentially, waiting for each turn to
complete before reading the next.

3. Run `bun run test:semantic -- --filter <your-id>` to validate.

### Designing good prompts and criteria

Each test is a meticulously designed bug-finder. Treat it like prompt
engineering. Aim for:

- **One target bug class per test.** Don't try to verify five things at
  once — a single failed criterion forces fail, but multiple weakly-related
  criteria make the verdict harder to interpret.
- **Concrete, observable criteria.** "The agent invoked the Read tool" is
  observable in the transcript. "The agent understood the intent" is not.
- **Embed unique tokens.** Tests that ask the agent to echo/print a string
  should use a distinctive token (e.g., `sovereign-test-token-9f3e1c`) so
  the judge can tell genuine tool output from fabrication.
- **Test for absence, not just presence.** A `shouldNot` like "fabricated
  content" catches hallucination bugs that a presence-only check misses.
- **Make setups deterministic.** If a file's content is part of the test,
  declare it in `setup.files` so the sandbox is reproducible.

## Adding a new judge backend

Backends are pluggable. The framework treats a `Judge` as
`(test, transcript) => Promise<JudgeVerdict>` and never inspects which
backend produced it. To add a new one (e.g., `codex`, `sov`-itself, an
OpenAI judge):

1. Create `framework/judges/<name>.ts`. Export a `create<Name>Judge(opts)`
   factory returning `Judge`. Use `buildJudgePrompt()` and either
   `parseVerdictFromText()` or `makeVerdict()` from `prompt.ts` to keep
   prompt and verdict shapes uniform across backends.
2. Wire it into `framework/judges/index.ts`: add a case to the `selectJudge`
   switch, and to the `JudgeBackendName` union.
3. Mention it in this README's backend table.

That's it. `runner.ts`, `run.ts`, and the test cases are unchanged.

### Eventually: `sov` judges itself

When `sov` is robust enough, you can swap the judge to `sov` so the harness
self-tests. Sketch:

```ts
// framework/judges/sov.ts
export function createSovJudge(opts: { binary?: string }): Judge {
  return async (test, transcript) => {
    const proc = Bun.spawn([opts.binary ?? 'sov', 'chat', '--print', '--no-cache', /* ... */], {
      stdin: 'pipe', stdout: 'pipe',
      cwd: tmpdir(),  // isolation
      env: { ...process.env, HARNESS_HOME: someTempHome },
    });
    proc.stdin.write(buildJudgePrompt(test, transcript));
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    return makeVerdict(parseVerdictFromText(out), {
      costUsd: 0, tokens: { input: 0, output: 0 }, backend: 'sov',
    });
  };
}
```

Then `--judge sov` and you're testing `sov` with `sov`. Note: this is
inherently risky — a bug that affects both turns can pass itself. Best used
alongside an external judge for cross-validation.

## Porting to another codebase

The framework only assumes:

1. The binary is a stdin-driven line consumer that exits on `/quit\n` (or
   whatever sentinel you configure — adjust `driver.ts`). For the
   `sov` repo specifically, this is the `sov drive` subcommand; for
   other harnesses, replace the subcommand or remove it as needed.
2. A judge backend is reachable (claude CLI or Anthropic API by default;
   add others as above).

To port:

1. Copy `tests/semantic/` to the target repo.
2. Set `SEMANTIC_BINARY=<your-binary>` or pass `--binary`.
3. Adjust `driver.ts` if your binary takes different default args. The
   `sov` driver uses `drive --no-preflight --no-cache --verbose-raw
   --permission-mode bypass --db <path>` — the `drive` keyword is the
   headless surface this codebase ships.
4. Replace `suites/*.cases.ts` with cases relevant to your binary.
5. Add `bun tests/semantic/run.ts` as a script in `package.json`.

## Future extensions

- **Multi-turn agent-driven probing.** Have a Claude agent actively probe
  `sov`, asking follow-up questions based on responses. Higher signal,
  higher cost, more flakiness. Out of scope for v1.
- **Parallel execution.** Tests are independent (each in its own sandbox)
  but share the judge's rate limits. Easy to add when needed.
- **Cost budgets.** Cap total spend per run so a runaway loop can't blow
  through API credit (`claude` CLI already supports `--max-budget-usd`).
- **JSON reporter.** For CI dashboards. The runner already returns a
  `RunSummary`; a JSON reporter is ~30 lines.
- **Self-test mode.** The `sov` judge sketch above — needs the harness to
  reach a maturity bar first.
