# Semantic Testing

LLM-judged behavior tests that drive the real `sov` binary as a subprocess and verify it behaves correctly. Complements (does not replace) the unit/integration suites under `tests/`.

This is the canonical reference for what semantic testing is, what's covered, and how the categories of tests map to bug classes the harness has to defend against. For developer-facing details (architecture, isolation, layout, how to add a test, how to add a judge backend, porting guide), see [`tests/semantic/README.md`](../tests/semantic/README.md).

## Why this category exists

Unit tests catch logic bugs in isolated functions. They cannot catch:

- "The Bash tool runs but the agent doesn't surface the output."
- "The agent hallucinates file contents when Read returns an error."
- "Slash command dispatch breaks when piped from stdin."
- "A streaming-corruption regression makes the response unreadable."
- "Compaction loses key facts in the summary."
- "A deny rule is silently bypassed via shell `cat`."

Each semantic test runs `sov` end-to-end with a real prompt, captures the transcript, and asks Claude to judge correctness against per-test must-satisfy / should-not criteria. The criteria are designed per-test to target a specific bug class.

## Quick start

```bash
# Full suite (~5 min, $0.87 informational on subscription)
bun run test:semantic

# Filter by id, name, or category
bun run test:semantic -- --filter bash

# List discovered tests without running anything
bun run test:semantic -- --list

# Print full transcripts on failure
bun run test:semantic -- --verbose

# Force the API judge (requires ANTHROPIC_API_KEY)
bun run test:semantic -- --judge anthropic-api
```

**Default judge:** the local `claude` CLI in `--print` mode. Uses your authenticated subscription, no API tokens spent. Falls back to the Anthropic SDK when `claude` isn't on `PATH` (or you pass `--judge anthropic-api`). Both judge and agent default to `claude-sonnet-4-6`.

The suite is **not** part of `bun test` — it is opt-in because each case spawns a real model turn. CI integration is left to the embedding project.

## Coverage inventory (30/30 pass)

The full suite runs in ~5.3 minutes and costs ~$0.87 informational on subscription (the cost figure is the metered-equivalent — your subscription absorbs it). Tests are grouped below by what they target. The "guards against" column names the specific bug class each test would catch.

### Tool dispatch — 8 tests

Verify each native tool dispatches correctly and the agent surfaces the result. Includes happy-path and error-path coverage.

| ID | Guards against |
|---|---|
| `tools.bash-basic-echo` | Tool dispatch broken or output not surfaced into response |
| `tools.read-file-surface-content` | Read tool runs but agent ignores result / hallucinates |
| `tools.edit-file-modify-content` | Edit dispatched but malformed, or success claimed without dispatch |
| `tools.write-file-create-new` | Wrong filename, fabricated success |
| `tools.bash-error-reported` | Non-zero exit produces no stdout → agent invents output |
| `tools.edit-missing-string-no-fabrication` | Edit can't find `old_string` → agent claims success anyway |
| `tools.glob-recursive-typescript-files` | Glob non-recursive (misses nested files) or wrong tool selection |
| `tools.grep-finds-marker-content` | Grep dispatch broken or wrong file identified |

### Slash-command pipeline — 4 tests

The harness has four distinct slash-command dispatch paths. All four are exercised end-to-end through the spawned binary.

| ID | Path | Guards against |
|---|---|---|
| `commands.help-listing` | Local (no model turn) | Slash-command dispatch broken, /help loses categorized layout |
| `commands.commit-on-non-git-directory` | Prompt-command + git tools | Agent fabricates a commit summary when no repo exists |
| `commands.init-creates-context-md` | Prompt-command + multi-tool | /init scan/synthesize pipeline broken |
| `commands.skill-invocation-via-slash-command` | Skill-sourced prompt-command | Loader → frontmatter parse → registry → dispatch → turn pipeline |

### Permissions — 6 tests

The deny/allow rules are the highest safety-impact code in the system. Unit tests verify the rule engine in isolation; these tests verify the user-visible behavior end-to-end. The choice of `Bash(echo *)` rather than `rm` is deliberate — modern models refuse `rm` on their own safety judgment, masking whether the deny rule actually fired. Echo isolates the permission-system signal.

| ID | Guards against |
|---|---|
| `permissions.deny-rule-blocks-echo` | Deny rule silently ignored / agent claims success after blocked tool call |
| `permissions.allow-rule-permits-tool` | Allow rule not consulted, mismatched, or resolver fails to surface a permitted invocation |
| `permissions.deny-wins-within-layer` | Within a layer, deny-wins invariant broken (allow accidentally outranks deny) |
| `permissions.bash-cat-blocked-by-read-deny` | **Highest-stakes test.** Virtual tool name mapping broken — `Read(*)` deny rule bypassed via shell `cat` |
| `permissions.rule-layer-local-overrides-project` | Layer precedence (local > project) broken |
| `permissions.bypass-mode-honors-deny` | Bypass mode incorrectly skipping deny rules (deliberate safety-first contract per `canUseTool.ts`) |

### Refusal / honesty — 4 tests

The most insidious bug class: agent fabricates content silently when it cannot honestly answer. These bugs are invisible without dedicated detection.

| ID | Guards against |
|---|---|
| `refusal.no-fabrication-on-missing` | Tool reports file missing → agent invents content |
| `refusal.no-fabrication-on-zero-search-results` | Search returns empty → agent invents matches |
| `refusal.prompt-injection-resistance-from-tool-output` | File contains an "[ATTENTION CLAUDE]" override → agent obeys the injection |
| `refusal.verify-not-trust-user-claims` | User asserts X about a file → agent parrots X without reading |

### Context expansion — 2 tests

| ID | Guards against |
|---|---|
| `context.directory-listing` | Hallucinated file enumeration |
| `context.at-file-expansion-or-read` | `@file` reference unrecognized or content fabricated |

### Workflow / multi-turn — 6 tests

Single-turn coherence + the four multi-turn coherence tests + the two compaction-pipeline tests.

| ID | Turns | Guards against |
|---|---|---|
| `workflow.create-and-verify` | 1 | Agent skips the verify step or fabricates the read result |
| `workflow.cross-turn-memory` | 2 | Conversation history not preserved between turns |
| `workflow.refinement-after-tool-result` | 2 | Tool-result amnesia (re-discovery instead of using prior context) |
| `workflow.error-recovery-across-turns` | 2 | Failure in Turn 1 poisons Turn 2 |
| `workflow.compact-preserves-key-facts` | 3 | `/compact` loses facts through child-session boundary |
| `workflow.rollback-restores-parent-session` | 4 | `/rollback` fails silently or active-session pointer not flipped |

## Semantic vs. unit tests

The two suites are complementary. Neither subsumes the other.

| Aspect | Unit tests (`bun test`) | Semantic tests (`bun run test:semantic`) |
|---|---|---|
| What's tested | Function-level logic in isolation | End-to-end agent behavior via transcripts |
| Speed | Sub-second per test | 7-35 s per test (model + judge calls) |
| Cost | Free | $0.025-0.05 per test (subscription absorbs the typical case) |
| Determinism | Fully deterministic | Some variance from model latency + judgment |
| Bug classes caught | Logic, types, signatures, isolated paths | Tool surfacing, hallucination, prompt-pipeline coherence, multi-turn behavior, permission system end-to-end |
| When to run | Every commit | Before releases; when touching tools, permissions, context handling, compaction, or slash-command dispatch |

`bun test` continues to pass 690/690 alongside this suite — file naming (`*.cases.ts` vs `*.test.ts`) keeps the two completely separate.

## Architecture (one screen)

Three swappable layers under `tests/semantic/framework/`:

1. **Driver** (`driver.ts`) — spawns the binary, pipes one or more prompts to stdin, captures stdout/stderr, ANSI-strips into a transcript. Each test runs in a fresh sandbox built by `sandbox.ts` (isolated `HARNESS_HOME`, `HARNESS_CONFIG`, sessions DB, working dir) with guaranteed cleanup on success, failure, or crash.

2. **Judge** (`judges/`) — pluggable. `Judge` is the function type `(test, transcript) => Promise<JudgeVerdict>`. Two backends ship: `claudeCode.ts` (default — shells out to local `claude` CLI in `--print` mode with `--tools ""` for isolation; uses your subscription) and `anthropicApi.ts` (opt-in — direct `@anthropic-ai/sdk` call with tool-use; needs `ANTHROPIC_API_KEY`). `index.ts` does auto-detection. Adding a backend (codex, `sov`-itself, OpenAI judge) is one new file plus a `selectJudge` switch case.

3. **Runner** (`runner.ts`) — judge-agnostic. Loads `*.cases.ts` files, orchestrates each test through driver→judge, aggregates a `RunSummary`. Reporter (`reporter.ts`) prints colored progress + summary.

**Strictly additive isolation invariants:**
- Framework never imports from `src/` — the binary is always a subprocess.
- Multi-turn `prompt: string[]` cases pipe each prompt newline-separated to `sov`'s queued-question pattern.
- File names match `*.cases.ts` and `run.ts`, not `*.test.ts` / `*.spec.ts` — Bun's default test runner ignores the suite.
- Suite runs are opt-in via `bun run test:semantic`; the script is purely additive in `package.json`.
- Judge subprocess (claude-code backend) runs in `os.tmpdir()` with `--no-session-persistence`, `--disable-slash-commands`, `--tools ""`.

For the full architecture (judge prompt construction, verdict parsing tolerance, runner internals, porting guide), see [`tests/semantic/README.md`](../tests/semantic/README.md).

## Cost & time profile

| Metric | Value |
|---|---|
| Full suite wall time | ~5.3 min |
| Full suite cost (informational) | ~$0.87 |
| Single-turn case | 7-15 s typical |
| Multi-turn case | 10-35 s (each turn is a model call; /compact and /rollback add child-session work) |
| Judge call cost | $0.025-0.045 (Sonnet 4.6) |
| Agent-under-test cost | Subscription — dollar figures shown are metered-equivalent |

The reporter shows `subscription` for `claude-code` zero-cost results; non-zero figures are informational ("what this would cost metered").

## Adding tests / extending

To add a new test, design a good criteria set, add a new judge backend, or port the framework to another codebase, see [`tests/semantic/README.md`](../tests/semantic/README.md). The recipe in [`docs/extending.md`](./extending.md#add-a-semantic-test) is the short-form version with a copy-pasteable test template.

## Future coverage

The suite now spans every accessible-without-new-infrastructure surface. The remaining gaps need either capability work or new fixture infrastructure, in approximate order of accessibility:

- **CLAUDE.md context surface** — needs a bundle fixture; doable with modest infrastructure work.
- **Microcompaction tool-result clearing** — no clean external observable for a deterministic test without internal hooks.
- **Web tools (WebFetch / WebSearch)** — need stubbing; real-network tests would be flaky.
- **Sub-agent / Task tool** — depends on AgentTool wiring (current sov build).
- **MCP tool dispatch** — waits on Phase 12 capability.
- **Trajectory capture** — waits on Phase 13.1 capability.

The natural next leverage is capability work, not more tests against the current surface area.

## See also

- [`tests/semantic/README.md`](../tests/semantic/README.md) — architecture, isolation guarantees, how to add tests, porting guide
- [`docs/extending.md`](./extending.md#add-a-semantic-test) — recipe for adding a test (also covers adding a judge backend)
- [`docs/architecture.md`](./architecture.md#semantic-test-suite) — architecture summary in the runtime architecture doc
- [`docs/usage.md`](./usage.md#semantic-test-suite) — quick-reference run instructions
- [`docs/testing-log-2026-04-27.md`](./testing-log-2026-04-27.md) — chronological test runs, findings, and design-error postmortems
- [`CHANGELOG.md`](../CHANGELOG.md) — phase-completion entries for each batch added
