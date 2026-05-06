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

## Coverage inventory (54/54 pass)

The full suite runs in ~10 minutes and costs ~$2.40 informational on subscription (the cost figure is the metered-equivalent — your subscription absorbs it). Tests are grouped below by what they target. The "guards against" column names the specific bug class each test would catch.

### Tool dispatch — 10 tests

Verify each native tool dispatches correctly and the agent surfaces the result. Includes happy-path and error-path coverage.

| ID | Guards against |
|---|---|
| `tools.bash-basic-echo` | Tool dispatch broken or output not surfaced into response |
| `tools.read-file-surface-content` | Read tool runs but agent ignores result / hallucinates |
| `tools.edit-file-modify-content` | Edit dispatched but malformed, or success claimed without dispatch |
| `tools.write-file-create-new` | Wrong filename, fabricated success |
| `tools.bash-error-reported` | Non-zero exit produces no stdout → agent invents output |
| `tools.edit-missing-string-no-fabrication` | Edit can't find `old_string` → agent claims success anyway |
| `tools.envelope-recovery-from-edit-mismatch` | **Phase 12.5.** FileEdit mismatch → agent retries the same wrong old_string blindly. The observation envelope's `next_actions` should make recovery reliable; this test catches regressions in the envelope renderer or in FileEditTool's error path |
| `tools.glob-recursive-typescript-files` | Glob non-recursive (misses nested files) or wrong tool selection |
| `tools.grep-finds-marker-content` | Grep dispatch broken or wrong file identified |
| `tools.main-agent-excludes-propose-tools` | **Phase 13.3 A2 (commit ec21277).** `memory_propose` / `skill_propose` accidentally re-added to `REGISTERED_TOOLS` (they must only appear in `REVIEW_ONLY_TOOLS` and be injected into review-fork sub-agents). Agent uses HarnessInfo to verify the live tool pool rather than guessing from training data. |

### Slash-command pipeline — 6 tests

The harness has four distinct slash-command dispatch paths. All four are exercised end-to-end through the spawned binary.

| ID | Path | Guards against |
|---|---|---|
| `commands.help-listing` | Local (no model turn) | Slash-command dispatch broken, /help loses categorized layout |
| `commands.context-budget-dispatch` | Local (no model turn) | **Phase 12.6.** /context-budget command dispatch, the new `CommandContext.getBudgetReport` hook, `auditContextBudget` / `formatBudgetReport` regressions |
| `commands.commit-on-non-git-directory` | Prompt-command + git tools | Agent fabricates a commit summary when no repo exists |
| `commands.init-creates-context-md` | Prompt-command + multi-tool | /init scan/synthesize pipeline broken |
| `commands.skill-invocation-via-slash-command` | Skill-sourced prompt-command | Loader → frontmatter parse → registry → dispatch → turn pipeline |
| `commands.skill-args-propagate-to-prompt` | Skill-sourced prompt-command | Slash-command arguments silently dropped when the skill body has no `{{args}}` placeholder (the original `/review ~/path` regression) |

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

### Self-doc / runtime introspection — 1 test

Pairs the `<harness-self-doc>` system-prompt segment (`src/context/systemPrompt.ts`) with the `HarnessInfo` runtime tool (`src/tools/HarnessInfoTool.ts`). The prompt teaches the contracts (settings paths, schemas, slash commands); the tool exposes the live state (loaded settings layers, connected MCP servers, tool inventory, registered commands). Together they prevent the agent from falling back to generic Claude-Desktop / SDK recall when the user asks meta-questions about the harness it's running in.

| ID | Guards against |
|---|---|
| `tools.harness-info-config-and-extension-guidance` | Agent answers MCP-config questions with `~/.harness/config.json` / Claude-Desktop guidance instead of `.harness/settings.json` + the `mcpServers` schema; agent fails to identify the configured server |

### Router — 1 test

Phase 10.6 part 1. `--provider router` resolves a meta-LLMProvider that wraps two child providers (a configured local lane + frontier lane) and routes per turn via the deterministic classifier in `src/router/classifier.ts`. Unit tests in `tests/router/` cover the classifier, audit logger, and provider in isolation; this end-to-end test catches REPL-side regressions like the synthetic ResolvedProvider missing a field, the audit logger blocking session start, or the model-string swap (req.model passed through to a child without lane-specific override).

| ID | Guards against |
|---|---|
| `router.router-completes-turn` | RouterProvider fails to wrap children, synthetic ResolvedProvider missing a field, audit logger crashes session boot, or the synthetic combined model string leaks to the child API call (404 from anthropic on an invalid model name) |

### Hooks — 2 tests

Phase 11 introduced user-configurable shell hooks at four lifecycle points (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`). Unit tests in `tests/hooks/` cover the runner shape, consent allowlist, and orchestrator wiring; these end-to-end tests catch regressions in the REPL plumbing where it's easiest to silently lose a hook event.

| ID | Guards against |
|---|---|
| `hooks.hook-pretooluse-blocks-bash` | PreToolUse hook fires but its deny verdict is dropped, or the orchestrator skips PreToolUse entirely |
| `hooks.hook-posttooluse-additional-context` | PostToolUse fires but its `additionalContext` is not appended to the tool_result that reaches the model |

### Defense-in-depth secret redaction — 1 test

The harness applies a permission-layer transformer to Write / Edit / NotebookEdit inputs that rewrites well-known secret patterns (GitHub OAuth, Stripe live/test, AWS access keys, Slack, Google API, JWTs, PEM private keys) to `<REDACTED:kind>` before the orchestrator dispatches the tool. This catches the failure class where an agent reads a real secret (from `~/.zshrc`, a config file, etc.) and accidentally reproduces it verbatim into a generated artifact like a security-audit report. Independent of model quality. Set `HARNESS_REDACTION=off` to disable globally (testing only).

| ID | Guards against |
|---|---|
| `redaction.redactor-rewrites-write-content-on-disk` | Secret-redaction transformer regression — agent's Write input contains a token, but the on-disk file ends up with the live secret instead of `<REDACTED:kind>` (would mean the canUseTool wrapper or the field-target map broke). Verified via Read-back through the same transcript. |

### Sub-agents — 2 tests

Phase 13 ships agent-as-tool delegation: the model invokes `AgentTool` with a `subagent_type` (one of the loaded agents from `<bundle>/agents/`) and a prompt; the harness spawns a child session with a filtered toolset, runs it to terminal, and returns a bounded summary wrapped in a `<subagent_result …>` envelope. The first test guards registry discoverability + the AgentTool surface (cheap, single-turn). The second is the end-to-end smoke for the full chain (parent → AgentTool → scheduler → child session → AgentRunner → child turns → renderResult → parent consumption); it adds the live-model layer that the unit + integration suites in `tests/runtime/scheduler*.test.ts` can't reach.

| ID | Guards against |
|---|---|
| `tools.agents-bundle-default-discoverable` | Agents/ directory not scanned at startup, AgentTool dropped from pool by `patchSchemasAgainstAvailable()`, `subagent_type` enum patch regressing, or model confusing sub-agents (delegated sessions) with skills (markdown procedures) |
| `tools.agents-explore-live-delegation` | AgentTool throws when called from a real model, scheduler fails to resolve a child provider, child session fails to start, child's tools end up wrong (allowedTools filter regression), `renderResult`'s `<subagent_result>` envelope breaks, or the parent model can't consume the wrapped child output |

### Task system — 4 tests

Phase 13.2 ships fire-and-forget sub-agent dispatch: the model invokes `task_create` (returns immediately with a task id), observes via `task_list` / `task_get` / `task_output`, and cancels via `task_stop`. The `/tasks` slash command renders the same lifecycle from the user's POV. Five tools + one slash command shipped without semantic coverage; this suite closes that gap. The task system wraps the Phase 13 `SubagentScheduler` with persistence (the `tasks` SQLite table) and lifecycle-aware controllers; unit + integration tests in `tests/tasks/` cover the manager and store deterministically with fake providers, while these end-to-end tests catch regressions in the live tool surface (description quality, schema enum patching for `subagent_type`, the manager not wiring into `ToolContext`, abort propagation through the scheduler, etc.). Cases intentionally do NOT require the task to have completed in the test window — task_create is fire-and-forget, so the assertions check that the right tools dispatched and surfaced sensible state, not that the child finished within N seconds.

| ID | Guards against |
|---|---|
| `tools.tasks-create-list-output-flow` | task_create not registering tasks under the parent session id, task_list missing in-flight tasks, task_output's bounded payload not surfacing state/summary, or the manager dropping tasks between create and observation |
| `tools.tasks-get-roundtrip-by-id` | task_get missing from the tool pool, the store losing rows between insert and read, or the model fabricating a round-trip claim without invoking task_get |
| `tools.tasks-stop-cancels-running-task` | task_stop missing from the parent tool pool (it's correctly excluded from sub-agents but must be present for the parent), the abort signal not propagating from the controller to the scheduler, or the manager not surfacing cancellation in subsequent task_get calls |
| `tools.tasks-unknown-subagent-type-errors-clearly` | task_create silently dropping unknown subagent_type calls or returning a fake task id; the schema-enum patch from `patchSchemasAgainstAvailable()` regressing; the tool-body defense-in-depth check missing |

### Review system — 6 tests

Phase 13.3 ships the `/review` slash command and the `memory_propose` / `skill_propose` tools. Unit + integration tests cover the ReviewManager, ProposalStore, and consolidation agent deterministically; these end-to-end tests cover the model-facing slash-command surface: does the model invoke the verbs correctly, and does the runtime surface meaningful errors on misuse. Auto-review forks (counter-driven internal dispatches) are not exercised here — they are not reachable via model-driven prompts and are covered by `tests/review/integration.test.ts`.

| ID | Guards against |
|---|---|
| `commands.review-list-empty-on-fresh-bundle` | /review erroring on the absent review/ directory on a fresh harness; model fabricating proposals that don't exist |
| `commands.review-show-nonexistent-id-errors-clearly` | Slash command swallowing a missing-id condition silently; model fabricating a proposal body for a non-existent id |
| `commands.review-consolidate-dispatches-or-degrades` | /review consolidate throwing an unhandled stack trace when ReviewManager is absent; model falsely claiming consolidation produced concrete merged proposals (T10, commit 2de1490) |
| `commands.review-unknown-verb-returns-usage` | Usage hint missing for unrecognized verbs; slash command silently treating unknown verb as the default (list) |
| `commands.review-activity-empty-on-fresh-bundle` | /review activity erroring on the absent sessions table; listSessions bridge breaking; model fabricating review activity that never happened (B3, commit f4676a9) |
| `commands.review-bare-call-shows-list-or-empty` | Bare /review triggering the unknown-verb fallback instead of the list-equivalent path |

### Security-audit skill — 1 test

The `/security-audit` skill (in `bundle-default/skills/`) provides threat-model scaffolding (actors → assets → exposure paths) and a per-finding verification gate to make a weaker model produce a defensible security audit. The skill prompt has hard rules: no fan-fiction, no platform mismatch (uname/sw_vers/etc/os-release first), no live secrets in artifacts, cite the verification command for every finding.

| ID | Guards against |
|---|---|
| `security.security-audit-skill-triggers-and-verifies` | Skill not loaded / trigger mismatch / model fabricates findings on state that doesn't exist; chat narration leaks the literal token (the redactor only catches file writes, not chat output — so this is the skill prompt's job) |

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
| `src/router/` | `--filter router` (covers `--provider router` end-to-end including model-swap) |
| `src/agents/loader.ts`, `src/agents/types.ts`, `src/agents/exclusions.ts` | `--filter agents` |
| `src/runtime/scheduler.ts`, `src/runtime/agentRunner.ts`, `src/runtime/semaphore.ts`, `src/runtime/laneSemaphores.ts` | `--filter agents` |
| `src/tools/AgentTool.ts` | `--filter agents` |
| `src/tool/registry.ts` (`patchSchemasAgainstAvailable`) | `--filter agents` |
| `src/tool/registry.ts` (`REVIEW_ONLY_TOOLS` export) | `--filter main-agent-excludes-propose` (pool-separation regression guard) |
| `src/router/capabilities.ts` | `--filter agents` (consumer is the scheduler) |
| `bundle-default/agents/*.md` | `--filter agents` |
| `src/tools/TaskCreateTool.ts`, `src/tools/TaskListTool.ts`, `src/tools/TaskGetTool.ts`, `src/tools/TaskOutputTool.ts`, `src/tools/TaskStopTool.ts` | `--filter tasks` |
| `src/tasks/manager.ts`, `src/tasks/store.ts`, `src/tasks/types.ts` | `--filter tasks` |
| `src/commands/taskOps.ts` (`/tasks` slash command) | `--filter tasks` |
| `src/review/` | `bun run test:semantic -- --filter review` |
| `src/commands/reviewOps.ts` | `bun run test:semantic -- --filter review` (covers list/show/consolidate/activity/unknown-verb/bare-call) |
| `bundle-default/agents/review-*.md` | `bun run test:semantic -- --filter review` |
| `src/permissions/secretRedactor.ts` | `--filter redaction` |
| `src/permissions/inputTransformer.ts` | `--filter redaction` |
| `src/permissions/redactSecretsTransformer.ts` | `--filter redaction` |
| `bundle-default/skills/security-audit.md` | `--filter security-audit` |
| `src/tools/ToolSearchTool.ts` | `--filter mcp-tool-search` |
| `src/tools/HarnessInfoTool.ts` | `--filter harness-info` |
| `src/context/systemPrompt.ts` (self-doc segment) | `--filter harness-info` |
| `src/tool/types.ts` (ToolObservation envelope) | `--filter envelope` |
| `src/core/orchestrator.ts` (`formatToolResult`) | `--filter envelope` |
| `src/context/budget.ts` | `--filter context-budget` |
| `src/commands/info.ts` (`/context-budget`) | `--filter context-budget` |
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

- **Adding a test** → add a row to the matching coverage table in [Coverage inventory](#coverage-inventory-4343-pass), update the headline count (`43/43 pass` → new total), and review whether the [Mapping table](#mapping-table--changed-area--tests) needs a new row (new source area → new filter) or any existing row needs updating.
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
- **Trajectory capture observable assertions** — Phase 13.1 ships trajectory capture, but external assertions on the captured artifact need a fixture path; coverage of capture behavior currently lives in unit + integration suites under `tests/trace/`.

The natural next leverage is capability work, not more tests against the current surface area.

## See also

- [`tests/semantic/README.md`](../tests/semantic/README.md) — architecture, isolation guarantees, how to add tests, porting guide
- [`docs/extending.md`](./extending.md#add-a-semantic-test) — recipe for adding a test (also covers adding a judge backend)
- [`docs/architecture.md`](./architecture.md#semantic-test-suite) — architecture summary in the runtime architecture doc
- [`docs/usage.md`](./usage.md#semantic-test-suite) — quick-reference run instructions
- [`docs/testing-log-2026-04-27.md`](./testing-log-2026-04-27.md) — chronological test runs, findings, and design-error postmortems
- [`CHANGELOG.md`](../CHANGELOG.md) — phase-completion entries for each batch added
