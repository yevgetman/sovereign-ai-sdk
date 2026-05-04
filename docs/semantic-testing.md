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

## Coverage inventory (34/34 pass)

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

### MCP — 2 tests

Phase 12 connects the harness to external MCP servers (filesystem, GitHub, Slack, etc.). MCP tools flow through the same orchestrator/permissions/hooks pipe as native tools (Invariant #5). Unit tests in `tests/mcp/` cover the SDK glue, tool wrapping, schema serialization, and ToolSearch lookup; these end-to-end tests catch regressions where MCP tools fail to reach the agent or bypass permissions.

| ID | Guards against |
|---|---|
| `tools.mcp-tool-search-then-invoke` | MCP tool not merged into the pool, deferred-schema handling broken, or ToolSearch fails to return the full schema |
| `permissions.mcp-permission-rule-blocks-server` | MCP tool bypasses the permission system — `mcp__<server>` deny rule must block every tool from that server |

### Hooks — 2 tests

Phase 11 introduced user-configurable shell hooks at four lifecycle points (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`). Unit tests in `tests/hooks/` cover the runner shape, consent allowlist, and orchestrator wiring; these end-to-end tests catch regressions in the REPL plumbing where it's easiest to silently lose a hook event.

| ID | Guards against |
|---|---|
| `hooks.hook-pretooluse-blocks-bash` | PreToolUse hook fires but its deny verdict is dropped, or the orchestrator skips PreToolUse entirely |
| `hooks.hook-posttooluse-additional-context` | PostToolUse fires but its `additionalContext` is not appended to the tool_result that reaches the model |

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

## When to run and when to extend

Each full-suite run costs ~5 min wall time and ~$0.87 informational on subscription. That's cheap enough to run before pushes, expensive enough that we don't run it on every commit. The triage below codifies what to run for a given change.

### Run policy

A four-tier rule based on what changed:

| Tier | Trigger | What to run |
|---|---|---|
| **Skip** | Doc-only / formatting / README updates that don't change code behavior | Nothing |
| **Filtered** | Touching one specific surface (one tool, one slash command, one permission rule path, one context surface) | `bun run test:semantic -- --filter <id-or-substring>` (~10-30 s, ~$0.03-0.10) |
| **Full suite** | Touching `src/core/query.ts`, `src/providers/`, `src/agent/sessionDb.ts` schema, `src/permissions/canUseTool.ts`, or any shared infrastructure that affects multiple surfaces; before pushing a substantive feature batch | `bun run test:semantic` (~5 min, ~$0.87) |
| **Gate** | Phase completion; before merging a substantive PR; before any release | `bun run test:semantic` + log entry in `docs/testing-log-2026-04-27.md` |

When in doubt, run the full suite. Five minutes and a dollar of subscription value is cheap insurance.

### Mapping table — changed area → tests

Use this when picking a `--filter` for a Tier 2 (filtered) run. If the change spans multiple rows, run all matching filters or just escalate to full suite.

| Changed area | Filter to run |
|---|---|
| `src/tools/Bash*` | `--filter bash` (also catches `bash-cat-blocked-by-read-deny`) |
| `src/tools/FileRead*` | `--filter read-file` |
| `src/tools/FileEdit*` | `--filter edit` (catches `edit-file-modify-content` + `edit-missing-string`) |
| `src/tools/FileWrite*` | `--filter write-file` |
| `src/tools/Glob*` | `--filter glob` |
| `src/tools/Grep*` | `--filter grep` |
| `src/tool/buildTool.ts` | `--filter tools` (full category — buildTool is shared) |
| `src/permissions/canUseTool.ts` | `--filter permissions` (full category — orchestrator-level) |
| `src/permissions/shellSemantics.ts` | `--filter virtual-tool` (specifically tests Bash→Read mapping) |
| `src/config/rules.ts` | `--filter permissions` |
| `src/config/settings.ts` (rule layers) | `--filter rule-layer` (tests local > project) |
| `src/commands/registry.ts` | `--filter commands` |
| `src/commands/sessionOps.ts` (`/init`, `/export`) | `--filter init` and `--filter commit` |
| `src/commands/info.ts` (`/help`, `/about`) | `--filter help` |
| `src/skills/loader.ts`, `src/skills/types.ts` | `--filter skill` |
| `src/context/system.ts` (system prompt, cwd) | `--filter context` |
| `src/context/userMessage.ts` (`@`-references) | `--filter at-file` |
| `src/compact/` | `--filter compact` |
| `src/agent/sessionDb.ts` | `--filter compact` and `--filter rollback` |
| `src/ui/terminalRepl.ts:rollbackNow` | `--filter rollback` |
| `src/hooks/` | `--filter hooks` (covers PreToolUse deny + PostToolUse additionalContext) |
| `src/mcp/` | `--filter mcp` (covers MCP discovery + invocation + permission-rule blocking) |
| `src/tools/ToolSearchTool.ts` | `--filter mcp-tool-search` |
| `src/core/query.ts` (turn loop) | **Full suite** — too core for filtering |
| `src/providers/` | **Full suite** — affects all model interactions |
| `src/ui/*` (rendering only) | Skip the semantic suite; the hardpass shell at `tests/_smoke/wave1-3-hardpass.sh` covers visual surfaces |

### Extension policy — when to add a new test

Add a new semantic test when ANY of:

- **A new tool ships.** Add a tool-dispatch case (and an error-path case if the tool has meaningful failure modes the agent must surface honestly).
- **A new slash command ships.** Local commands need at least one dispatch test; prompt-commands also need an end-to-end behavior test like `/commit` or `/init`.
- **A new permission rule path ships** — a new rule type, a new layer, a new virtual tool name mapping. Add a permissions case demonstrating the user-visible behavior.
- **A new context surface ships** — new `@`-reference type, new system-prompt section, new auto-injected fact. Add a context case.
- **A bug is fixed that wasn't caught by existing tests.** Add a regression case that would have caught the bug. Name and description should reference the bug class so future maintainers know why the test exists.
- **A phase completes.** Audit the user-visible behaviors the phase introduces. Each new behavior class should have at least one semantic test before the phase is marked done.
- **A design decision introduces a new invariant.** If the invariant is observable in the agent's transcript, write a test that pins it. Two such tests already exist by happy accident — `bypass-mode-honors-deny` and `deny-wins-within-layer` both pin documented invariants from `canUseTool.ts`.

Don't add a semantic test when:
- The change is an internal refactor that preserves user-visible behavior. Unit tests are the right level.
- The change is UI/rendering polish. The hardpass shell at `tests/_smoke/wave1-3-hardpass.sh` is the right place.
- The change is a performance optimization. Wrong test category.
- The behavior is already covered by an existing test. Don't duplicate.

### When the suite changes, update this document in the same commit

This file is the single source of truth for what the suite covers and how to triage runs. **Any change to `tests/semantic/suites/` must be paired with an update here**, in the same commit. Specifically:

- **Adding a test** → add a row to the matching coverage table in [Coverage inventory](#coverage-inventory-3030-pass), update the headline count (`30/30 pass` → new total), and review whether the [Mapping table](#mapping-table--changed-area--tests) needs a new row (new source area → new filter) or any existing row needs updating.
- **Removing a test** → delete its row from the inventory, drop the count, and remove any rows in the mapping table that pointed only at that test.
- **Renaming a test** → update the inventory row and the mapping table; check that no `--filter` substring suggestion in the table relied on the old name.
- **Adding a new category file** (e.g., `10-newtopic.cases.ts`) → add a section to the coverage inventory and link the new file in the layout under [`tests/semantic/README.md`](../tests/semantic/README.md).
- **Adding a new judge backend** → update the backend table in [`tests/semantic/README.md`](../tests/semantic/README.md) and the backends paragraph in [Architecture (one screen)](#architecture-one-screen).
- **Changing the cost or runtime profile** (e.g., timeouts, model defaults) → update [Cost & time profile](#cost--time-profile) and the per-tier cost figures in [Run policy](#run-policy).

If you add a test without updating the inventory and the mapping table, the policy lies — contributors will read it expecting accurate triage and find their `--filter` choice doesn't match what the suite actually contains. Drift here defeats the point of the policy.

### Future automation (not yet built)

A `select-tests-from-diff.sh` helper that runs `git diff --stat` and emits the appropriate `--filter` flag would make Tier 2 fully automatic. Not built yet — the mapping table above is the manual version. Add this helper when the cost of looking up the right filter exceeds the cost of writing the script (probably never, given the table fits on one screen).

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
