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
# Run the 10 slash-command cases with string-match judge (~1 s, $0)
bun run test:semantic -- --judge string-match --filter commands.

# Filter by id, name, or category (LLM judge, for non-command surfaces)
bun run test:semantic -- --filter bash

# List discovered tests without running anything
bun run test:semantic -- --list

# Print full transcripts on failure
bun run test:semantic -- --verbose

# Force the API judge (requires ANTHROPIC_API_KEY)
bun run test:semantic -- --judge anthropic-api
```

**Default judge:** the local `claude` CLI in `--print` mode. Uses your authenticated subscription, no API tokens spent. Falls back to the Anthropic SDK when `claude` isn't on `PATH` (or you pass `--judge anthropic-api`). Both judge and agent default to `claude-sonnet-4-6`. The `string-match` backend (`--judge string-match`) is purely deterministic and costs nothing.

The suite is **not** part of `bun test` — it is opt-in. CI integration is left to the embedding project. As of Phase 16.0c SD2, only the 10 slash-command cases are runnable (via `sov dispatch`); the remaining 54 require an agent-headless surface that is not yet shipped.

## Coverage inventory (10 runnable / 64 declared)

**Headline:** 10 of 64 declared tests are runnable today. The 10 runnable cases are the Wave 1 slash-command cases in `02-commands.cases.ts`; they run against the headless `sov dispatch` surface with the `string-match` judge, cost $0, and complete in ~1 s. The remaining 54 declared cases require agent turns driven by a real LLM; they cannot run against the current `dispatch`-only driver and are blocked pending a future agent-headless surface that reintroduces model-turn support. When that surface lands, those 54 will re-join the runnable set and the cost/time profile will return to the historical ~$0.87 / 5-min range.

To run only what works today:

```bash
# 10/10 in ~1 s, $0 cost — no model invocation
bun run test:semantic -- --judge string-match --filter commands.
```

Tests are grouped below by what they target. The "guards against" column names the specific bug class each test would catch.

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

### Slash-command pipeline — 10 tests (runnable via `sov dispatch` + string-match judge)

Phase 16.0c SD2 rewired this bucket to use the headless `sov dispatch` surface (see [Architecture](#architecture-one-screen) for details). Each case issues one or more slash commands to the dispatch loop and asserts on literal output substrings — no LLM is invoked and cost is always $0.

The five agent-turn-driven cases from before SD2 (`commands.context-budget-dispatch`, `commands.help-listing`, `commands.init-creates-context-md`, `commands.commit-on-non-git-directory`, `commands.slash-help-and-clear`) were removed because `sov chat` no longer exists and the dispatch surface does not support agent turns. They will return when an agent-headless surface is reintroduced.

| ID | Turns | Guards against |
|---|---|---|
| `commands.help` | 1 | Slash registry un-wired or a Wave 1 command dropped from `/help` output |
| `commands.about` | 1 | `/about` losing one of its labeled rows (profile/provider/model/session) |
| `commands.cost` | 1 | Zero-cost contract broken or formatted output structure wrong in a fresh headless session |
| `commands.model` | 2 | No-arg `/model` not printing current model/usage; `/model <name>` not confirming the switch |
| `commands.config` | 2 | `/config show` or `/config path` regressing or printing the usage banner by mistake |
| `commands.permissions` | 1 | Permissions snapshot accessor broken; sandbox default mode ("default") not reported |
| `commands.tools` | 1 | `/tools` producing an empty pool or losing core tools (Bash, FileRead) |
| `commands.skills` | 1 | Skill loader silently returning nothing; default-bundle skill missing from `/skills` output |
| `commands.clear` | 1 | `/clear` LocalCommand losing its return string |
| `commands.clear-resets-cost` | 3 | `/clear` inflating or erroring the subsequent `/cost` call (idempotent in a zero-cost session) |

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
| `tools.agents-bundle-default-discoverable` | Agents/ directory not scanned at startup, AgentTool dropped from pool by `patchSchemasAgainstAvailable()`, `subagent_type` enum patch regressing, model confusing sub-agents with skills, or a bundled agent (explore / verify / plan / scheduled-mission) missing from the registered set |
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

### Phase 13.4 — Learning system — 4 tests

Phase 13.4 ships the instinct corpus, the `LEARNING_ONLY_TOOLS` pool export (four tools: `instinct_list` / `instinct_view` / `instinct_propose` / `instinct_update_confidence`), and the `instinct-synthesizer` bundled sub-agent. CLI subcommands (`harness learning status / prune / export`) are not exercised here — they run outside the in-chat semantic runner and have unit-level coverage in `tests/cli/learningCommands.test.ts`. These four cases target the user-visible contract: tool-pool isolation, agent discoverability, and correct user-facing guidance about the CLI vs slash-command split.

| ID | Guards against |
|---|---|
| `tools.main-agent-excludes-instinct-tools` | The four `instinct_*` tools accidentally re-added to `REGISTERED_TOOLS` (they must live only in `LEARNING_ONLY_TOOLS` and be injected into the instinct-synthesizer sub-agent's pool). Agent uses HarnessInfo to verify the live pool rather than guessing from training data. Same structure as Phase 13.3's `main-agent-excludes-propose-tools` guard. |
| `tools.instinct-synthesizer-agent-bundled` | `bundle-default/agents/instinct-synthesizer.md` not scanned at startup, or `AgentTool`'s `subagent_type` enum patch dropping the new agent — agent uses HarnessInfo agents section to confirm discoverability. |
| `tools.learning-cli-not-confused-with-slash-command` | Agent fabricates output for `/learning status` (not a slash command) or claims it is a registered slash command; the correct invocation is `harness learning status` / `sov learning status` at the CLI level. |
| `tools.instinct-tools-described-as-internal-only` | Main agent incorrectly claims it can call `instinct_propose` or `instinct_update_confidence` directly; correct behavior is to report them absent from its pool (verified via HarnessInfo) and describe them as synthesizer-internal. |

### Phase 16.0a — Daemon skeleton — 0 tests (audited, none required)

Phase 16.0a ships the daemon infrastructure: channel types, `buildSessionKey`, `send()` with local outbox, LRU `SessionCache`, `ApprovalQueue` with TTL expiry, typed `DaemonEventBus`, `startDaemon()` runner, and `harness daemon` CLI command. None of these surfaces are agent-facing — the daemon infrastructure is headless (Phase 16.0b's Ink TUI is the foreground subscriber, not yet shipped). No new tools, slash commands, permission rules, or context surfaces were added. Unit tests in `tests/channels/` and `tests/daemon/` cover all behavior deterministically (1805/1805 unit suite). The semantic suite remains at **58/58**.

### Phase 16.0b — Ink TUI + task event bus subscription — 0 tests (audited, none required)

Phase 16.0b replaces the readline REPL (`src/ui/terminalRepl.ts`) with an Ink-based TUI in `src/ui/ink/` (App + Transcript + Prompt + StatusLine, pure UiState reducer, useBusSubscription + useAgentTurn hooks), wires TaskManager to emit `task_update` on the daemon bus (with `safeEmit` to isolate listener throws), and extracts the non-interactive scheduled-mission wake into `src/cli/missionRun.ts` (now invoked as `sov mission run --state-dir <path>`). Bare `sov` and `harness` mount the TUI as the default Commander action; the `chat` subcommand is removed. No new agent-facing tools, slash commands, permission rule paths, or context surfaces — the TUI is a presentation layer over the same slash-command registry, tool pool, and permission system that `terminalRepl.ts` drove. Unit tests under `tests/ui/ink/` cover the reducer, hooks, and components deterministically; helper-test count dropped from a ~1820+ peak to **1700/1700** at HEAD as the readline REPL's helper modules were deleted alongside it. The semantic suite remains at **58/58**.

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

`bun test` continues to pass 1490/1490 alongside this suite — file naming (`*.cases.ts` vs `*.test.ts`) keeps the two completely separate.

## Architecture (one screen)

Three swappable layers under `tests/semantic/framework/`:

1. **Driver** (`driver.ts`) — spawns `<binary> dispatch` (the headless slash-command surface introduced in Phase 16.0c SD1), pipes one or more slash commands to stdin one line at a time, captures stdout/stderr, and ANSI-strips into a transcript. The driver waits for `READY_MARKER` after boot and `TURN_SEPARATOR` after each command's output — both magic strings are imported from `src/cli/dispatchCommand.ts` so they have a single source of truth and never drift. Each test runs in a fresh sandbox built by `sandbox.ts` (isolated `HARNESS_HOME`, `HARNESS_CONFIG`, sessions DB, working dir) with guaranteed cleanup on success, failure, or crash.

   **Important:** `sov dispatch` is a slash-command-only surface. It does not open an LLM session and does not support agent turns. The 54 declared cases that require real model turns (tool dispatch, permissions end-to-end, workflow multi-turn, etc.) are currently blocked — tracked in the inventory but not runnable until an agent-headless surface is reintroduced.

2. **Judge** (`judges/`) — pluggable. `Judge` is the function type `(test, transcript) => Promise<JudgeVerdict>`. Three backends ship:
   - `stringMatch.ts` (**new in SD2**, select with `--judge string-match`) — purely deterministic substring assertions; no model invoked, cost always $0. Recommended for slash-command cases where expected output is a literal string.
   - `claudeCode.ts` (default) — shells out to local `claude` CLI in `--print` mode with `--tools ""` for isolation; uses your subscription.
   - `anthropicApi.ts` (opt-in) — direct `@anthropic-ai/sdk` call with tool-use; needs `ANTHROPIC_API_KEY`.

   `index.ts` does auto-detection. Adding a backend is one new file plus a `selectJudge` switch case.

3. **Runner** (`runner.ts`) — judge-agnostic. Loads `*.cases.ts` files, orchestrates each test through driver→judge, aggregates a `RunSummary`. Reporter (`reporter.ts`) prints colored progress + summary.

**Strictly additive isolation invariants:**
- Framework never imports from `src/` — the binary is always a subprocess. (`driver.ts` imports `READY_MARKER` and `TURN_SEPARATOR` as plain string constants from `src/cli/dispatchCommand.ts` at build time, but no executable logic.)
- Multi-turn `prompt: string[]` cases pipe each prompt as a newline-separated sequence; the dispatch loop emits one `TURN_SEPARATOR` per command.
- File names match `*.cases.ts` and `run.ts`, not `*.test.ts` / `*.spec.ts` — Bun's default test runner ignores the suite.
- Suite runs are opt-in via `bun run test:semantic`; the script is purely additive in `package.json`.
- Judge subprocess (claude-code backend) runs in `os.tmpdir()` with `--no-session-persistence`, `--disable-slash-commands`, `--tools ""`.

For the full architecture (judge prompt construction, verdict parsing tolerance, runner internals, porting guide), see [`tests/semantic/README.md`](../tests/semantic/README.md).

## Cost & time profile

| Metric | Value |
|---|---|
| Runnable today (10 string-match cases) | ~1 s, $0 |
| Full suite when agent-headless surface returns | ~5.3 min, ~$0.87 (historical) |
| Single-turn LLM case | 7-15 s typical |
| Multi-turn LLM case | 10-35 s (each turn is a model call; /compact and /rollback add child-session work) |
| Judge call cost (claude-code or anthropic-api) | $0.025-0.045 (Sonnet 4.6) |
| Judge call cost (string-match) | $0 — no model invoked |
| Agent-under-test cost | Subscription — dollar figures shown are metered-equivalent |

The reporter shows `subscription` for `claude-code` zero-cost results; non-zero figures are informational ("what this would cost metered"). The `string-match` backend always reports $0 regardless of subscription.

## When to run and when to extend

As of Phase 16.0c SD2, the 10 slash-command cases are the only runnable segment. The full-suite cost/time profile will return when an agent-headless surface is reintroduced. The triage below reflects the current runnable state.

### Run policy

A four-tier rule based on what changed:

| Tier | Trigger | What to run |
|---|---|---|
| **Skip** | Doc-only / formatting / README updates that don't change code behavior | Nothing |
| **Filtered (slash commands)** | Touching `src/commands/*.ts`, `src/cli/dispatchCommand.ts`, or any Wave 1 slash command implementation | `bun run test:semantic -- --judge string-match --filter commands.` (~1 s, $0) |
| **Filtered (other surfaces)** | Touching one non-command surface (one tool, one permission rule, one context surface) | `bun run test:semantic -- --filter <id-or-substring>` — note: those 54 cases are currently deferred; the command passes but no cases match if the surface is agent-turn-only |
| **Full suite** | Before pushing a substantive feature batch, or when the agent-headless surface is reintroduced | `bun run test:semantic` (~5 min, ~$0.87 when all 64 cases are runnable) |
| **Gate** | Phase completion; before merging a substantive PR; before any release | `bun run test:semantic` (filtered today; full when coverage resumes) + log entry in `docs/testing-log-2026-04-27.md` |

When touching slash commands today: `--judge string-match --filter commands.` is the right call — 1 second, $0, definitive.

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
| `src/commands/registry.ts` | `bun run test:semantic -- --judge string-match --filter commands.` (full Wave 1 bucket, 10 cases, $0) |
| `src/commands/sessionOps.ts` (`/clear`, `/cost`, `/quit`, `/model`) | `--judge string-match --filter commands.clear` and `--filter commands.cost` and `--filter commands.model` |
| `src/commands/sessionOps.ts` (`/init`, `/export`) | Unit coverage only — agent-turn path; no runnable semantic case until agent-headless surface lands |
| `src/commands/info.ts` (`/help`, `/about`) | `--judge string-match --filter commands.help` and `--filter commands.about` |
| `src/commands/configOps.ts` (`/config`) | `--judge string-match --filter commands.config` |
| `src/commands/permissionsOps.ts` (`/permissions`) | `--judge string-match --filter commands.permissions` |
| `src/commands/toolsOps.ts` (`/tools`) | `--judge string-match --filter commands.tools` |
| `src/commands/skillsOps.ts` (`/skills`) | `--judge string-match --filter commands.skills` |
| `src/cli/dispatchCommand.ts` (READY_MARKER, TURN_SEPARATOR, dispatch loop) | `--judge string-match --filter commands.` (all 10 string-match cases exercise the dispatch surface) |
| `src/ui/ink/hooks/useAgentTurn.ts` (slash dispatch in TUI) | Unit coverage only — TUI is a rendering surface; use `tests/_smoke/wave1-3-hardpass.sh` for visual regression |
| `src/ui/ink/state/reducer.ts` (`transcript_cleared` → zeroes `sessionCost`) | Unit coverage only — reducer is tested in `tests/ui/ink/`; semantic coverage returns when agent-headless surface ships |
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
| `src/tool/registry.ts` (`LEARNING_ONLY_TOOLS` export) | `--filter main-agent-excludes-instinct` (pool-separation regression guard for Phase 13.4) |
| `src/learning/`, `src/tools/Instinct*Tool.ts` | `--filter learning` |
| `bundle-default/agents/instinct-synthesizer.md` | `--filter instinct-synthesizer` |
| `src/router/capabilities.ts` | `--filter agents` (consumer is the scheduler) |
| `bundle-default/agents/*.md` | `--filter agents` |
| `bundle-default/agents/scheduled-mission.md` | `--filter agents` (discoverability — `agents-bundle-default-discoverable` mustSatisfy includes it) |
| `src/mission/state.ts`, `src/mission/fsm.ts`, `src/mission/segments.ts`, `src/mission/paths.ts` | Unit coverage only — no semantic test yet; the wake lifecycle requires `--state-dir` setup that the current driver doesn't handle |
| `src/ui/terminalRepl.ts` (`--agent` / `--state-dir` paths) | Unit coverage only — manual smoke test in Task 8; semantic driver support for pre-run dir setup would be needed for end-to-end coverage |
| `src/cli/missionInit.ts` | Unit coverage only — `sov mission init` is a non-interactive CLI subcommand; no semantic test needed |
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

- **Adding a test** → add a row to the matching coverage table in [Coverage inventory](#coverage-inventory-10-runnable--64-declared), update the headline counts (`10 runnable / 64 declared` → new totals — update both the runnable count if the new case is immediately executable against `sov dispatch`, and the declared total), and review whether the [Mapping table](#mapping-table--changed-area--tests) needs a new row (new source area → new filter) or any existing row needs updating.
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
