# Sovereign AI — Agent Runtime

The agent runtime for Sovereign AI. A Claude-Code-style harness (TypeScript on Bun, async-generator turn loop, `Tool<I,O>` factory with fail-closed defaults, content-block messages) with a Hermes-pattern learning layer on top (persistent memory, trajectory capture, background review).

This is **runtime code**. The business data it operates against lives in a separate repo: `~/code/sovereign-ai-docs/`. This repo reads that one as a *harness bundle* and never writes to business-scope files; runtime state lives under `$HARNESS_HOME` (default `~/.harness`) unless a later phase introduces explicit bundle-state writers.

## Status

**Current state (2026-05-12).** Phases 0 through 13.5 are shipped. Phase 16.0a (daemon skeleton) code is in tree but dormant after the Phase 16 revert. The post-13.4 backlog has 1 open item left (`17`, P4, non-blocking). Unit baseline is **1809/1809**; semantic baseline is **57/58** (1 model-behavior flake unrelated to current work). No active phase — the next foreground refactor (Phase 16.1) must follow Rule 1 of the revert retrospective and ship behind a parallel surface. See [`docs/state-of-build-2026-05-12.md`](docs/state-of-build-2026-05-12.md) for the close-out snapshot and [`docs/retrospective-2026-05-12-phase-16-revert.md`](docs/retrospective-2026-05-12-phase-16-revert.md) for the durable rules.

**Phase 16 revert + `sov dispatch` (2026-05-12).** Phase 16.0b (Ink TUI) and Phase 16.0c (slash dispatch on Ink) were force-rolled back to commit `e9d5445`. Two follow-up commits layered the surviving improvements: a `string-match` semantic-judge backend (`tests/semantic/framework/judges/stringMatch.ts`, deterministic literal-substring assertions at $0/run) and a new headless slash surface `sov dispatch` (`src/cli/dispatchCommand.ts` — reads stdin, dispatches via the existing registry, prints output framed by `--- ready ---` / `--- end-of-turn ---`, exits on EOF or `/quit`). `sov chat` is now deprecated as an explicit keyword (bare `sov` is the canonical interactive entrypoint). The Ink TUI work is preserved at `origin/archive/ink-tui-2026-05-12`.

**Phase 13.5 — Scheduled-mission sub-agents (2026-05-11).** Mission-dir file contract (`src/mission/` — types, paths, state loader/atomic-writer/lock, FSM, prompt segments), `AgentDefinition.supportsMissionState` frontmatter field, `bundle-default/agents/scheduled-mission.md` wake-contract agent, `--agent` + `--state-dir` flags on `sov chat`, full mission lifecycle wired in `terminalRepl.ts` (overlap lock via mkdir, FSM terminal-state early-exit, system-prompt injection with cacheable goal/plan/state + ephemeral notes/wake-log, per-agent tool restriction, auto-wake user message, `MISSION_TRANSITION=<state>` sentinel parsing, `<mission-notes-update>` block, wake-log append, atomic state write-back, lock release in try/finally), `sov mission init <dir> --goal "..."` subcommand, `sov mission run --state-dir <dir>` non-interactive wake entrypoint, `harness` bin alias. Unit suite at 13.5 close: 1769/1769.

**Phase 13.4 — Continuous-learning observation stream + instinct corpus (2026-05-06).** Every tool call can write a per-project observation to `$HARNESS_HOME/learning/<projectId>/observations.jsonl` via `LearningObserver` on the internal `PostToolUse` path. The bundled `instinct-synthesizer` sub-agent clusters observations into atomic, confidence-weighted instincts stored under `$HARNESS_HOME/learning/<projectId>/instincts/`. Four instinct tools (`instinct_list`, `instinct_view`, `instinct_propose`, `instinct_update_confidence`) live in `LEARNING_ONLY_TOOLS`, never the main pool. Review forks now prefer the instinct corpus over raw trajectory slices, and `sov learning {status,prune,export}` exposes read-only inspection and maintenance. Semantic suite: 58/58. Unit suite at 13.4 close: 1583/1583.

**Post-Phase-13.4 backlog burn (2026-05-06 → 2026-05-07).** 20 of 24 backlog items closed, including per-child trace files, synthesizer activity-burst dispatch, multi-process observation append verification, skill-shaped child triage, and two-tier `MEMORY.md` routing. All P0/P1/P2 items are closed. Remaining open: microcompaction deepening, shell AST analysis deepening, eval-gated auto-promote, and `maxToolCallsBeforeCheckin`.

**Phase 13.3 — Background review daemon + close-out (2026-05-06).** Counter-driven ReviewManager triggers review forks after N user turns (memory) or M tool iterations (skills). Three new reference agents in `bundle-default/agents/` (`review-memory`, `review-skill`, `review-consolidate`) bring the total to six. `memory_propose` and `skill_propose` tools write pending proposals to `$HARNESS_HOME/review/pending/` with full provenance frontmatter; the `/review` slash command (list/show/approve/reject/consolidate/activity verbs) drives the propose-then-promote lifecycle. REVIEW_ONLY_TOOLS pool-separation hard-excludes these tools from the main agent's pool. Close-out batch (commits ec21277–e516a43) adds efficiency throttling, trace tagging, trajectory routing, graceful abort propagation, phantom cleanup, and C2 auto-promote provenance preservation. Semantic suite: 54/54. Unit suite: 1490/1490.

**Phase 13 — Sub-agent runtime + AgentTool (2026-05-05).** The model can spawn bounded specialized agents that run as their own sessions with filtered toolsets, return concise summaries, and feed parent memory via the `on_delegation` hook. Three initial reference agents ship in `bundle-default/agents/`: `explore` (read-only codebase mapping), `verify` (independent claim checking), `plan` (implementation planning). Architecture: agent definitions are markdown + frontmatter (same loader pattern as skills); `SubagentScheduler` (`src/runtime/scheduler.ts`) owns per-parent child caps, per-lane concurrency semaphores (the deferred Phase 10.6 piece), a global write-path lock for write-capable children, per-child timeout via `AbortSignal.timeout()` composed with the parent's signal via `AbortSignal.any()`, and provider/model resolution — agents declare `model: <provider>/<id>` literally or `role: explore` and the runtime resolves through a capability profile table to the cheapest matching model. `AgentTool` is a thin `buildTool()` wrapper; the registry's `patchSchemasAgainstAvailable()` rewrites the `subagent_type` field from open-string to a closed enum derived from loaded agents (drops the tool entirely when no agents are loaded). Global exclusion set (`src/agents/exclusions.ts`) prevents recursive sub-agent spawning + parent-side control-plane tool leakage to children. Parent-child session lineage flows through the existing schema-v3 `parent_session_id` column.

**Phase 13.1 — Trajectory capture (2026-05-04).** The Sovereign moat. Every completed session writes a ShareGPT-shaped JSONL record (with thinking blocks rendered as `<think>` tags for cross-model compatibility) to `<bundle>/state/artifacts/trajectories/samples.jsonl` or `<harnessHome>/trajectories/samples.jsonl`. Records are redacted at write via a 14-pattern allowlist (Anthropic / OpenAI / Tavily / Brave / OpenRouter / GitHub PATs / AWS keys / JWTs / bearer tokens / PEM private keys / credential file paths). `HARNESS_REDACT_SECRETS=0` disables (snapshotted at import per Invariant #15 — agent tool calls can't disable mid-session).

**Phases 9.6 + 12.5 + 12.6 (2026-05-04)** — three follow-on polish phases, all shipped.

- **Phase 12.5 — tool observation envelope.** Optional uniform `{status, summary, next_actions, artifacts}` shape on every `ToolResult`. The orchestrator renders it as a header above each tool's existing output; `status: 'error'` forces `is_error`. Retrofitted across all native tools (BashTool with per-error-class hints; FileEditTool flips its missing-match / non-unique-match throws to envelope-emitting returns) and the MCP wrapper. Lifts ECC's "Observation Design" + "Error Recovery Contract".
- **Phase 12.6 — context budget audit + `/context-budget`.** `auditContextBudget()` walks system-prompt segments, tool schemas, skills, bundle context, and memory; emits per-component token estimates with bloat tier (`heavy` / `extreme`) and triage class (`always` / `sometimes` / `rarely`). Exposed via the new `/context-budget` slash command and a `'budget'` section on `HarnessInfo`.
- **Phase 9.6 — skill `whenToUse` trigger rigor.** Loader-time lint flags low-rigor strings (descriptive preambles, missing trigger verb); SkillsListTool splits semicolon-separated `whenToUse` values into a discrete predicate array.

**HarnessInfo + self-doc (2026-05-04)** — meta-question support. New `HarnessInfo` native tool returns runtime state (settings layers, MCP servers, native + MCP tools, slash commands, optional budget audit). New `<harness-self-doc>` system-prompt segment teaches the model the harness's settings file paths, schema for `permissions` / `hooks` / `mcpServers`, and slash-command list — vendor-neutral so white-label deployments inherit it unchanged.

**Phase 12 (MCP client, 2026-05-03)** — stdio MCP servers via `@modelcontextprotocol/sdk@1.29.0`. Discovered tools wrap as `mcp__<server>__<tool>` and flow through the same `Tool<I,O>` pipe. `mcp__<server>` permission rules block every tool from one server in one line. Deferred-tool loading via `ToolSearch` keeps prompt token cost bounded as MCP servers add tens of tools.

**Phase 11 (shell hooks, 2026-05-02)** — `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` hooks. JSON-stdio command interface, exit-code-2 = block, first-use TTY consent gated by `~/.harness/shell-hooks-allowlist.json`.

**REPL polish (Phase 10.5b–e, 2026-05-03)** — modal-framed permission prompts, persistent pre-prompt footer, inline FileEdit/FileWrite diffs, theme system (`dark` / `light` / `no-color` + `NO_COLOR`), comprehensive slash-command surface (see `/help` for the live registry), raw-mode input editor (multi-line, persistent history, Ctrl-R reverse search, Tab autocomplete, soft-wrap).

**Sudo guardrail + inline shell escape hatch (2026-05-03)** — `BashTool` refuses `sudo` / `pkexec` / `doas` / `su` upfront with a structured error so the harness doesn't hang waiting for a password prompt. The `! <command>` REPL prefix runs the rest as a bash command with the user's TTY inherited — the explicit escape hatch for sudo / TouchID / pagers / interactive editors.

**Semantic test suite (58/58 pass).** Opt-in LLM-judged behavior tests. Default judge is the local `claude` CLI (subscription, no API tokens). Coverage spans 10 tool-dispatch cases (including pool-separation guards for `memory_propose` / `skill_propose` and the Phase 13.4 `instinct_*` tools), 6 slash-command pipeline paths, 6 permission cases, 4 refusal cases, 2 context-expansion cases, 2 MCP cases, 2 hook cases, 1 self-doc/harness-info case, 1 router case, 1 secret-redaction case, 1 `/security-audit` skill case, 2 sub-agents cases, 4 task-system cases, 6 review-system cases (`/review` list/show/consolidate/activity/unknown-verb/bare-call), 4 learning-system cases, and 6 workflow/multi-turn cases. Run with `bun run test:semantic`. See [`docs/semantic-testing.md`](docs/semantic-testing.md) for the full inventory and run policy.

**Phase 10 (compaction, 2026-04-26)** — `/compact` and `/rollback`, parent-child session lineage, separate compaction cost lanes, proactive compaction above 75% of context, reactive retry after context-overflow errors. Microcompaction (per-part tool-result clearing) and shell-AST virtual tool mapping landed as Qwen-amendment deepenings on 2026-04-28.

**Next high-leverage target:** none active. The next foreground refactor (Phase 16.1, when retried) must follow Rule 1 of the revert retrospective: keep terminalRepl alive in parallel. Phase 16 rebuild prerequisites (the ~20 silently-broken-in-Ink subsystems that any future attempt must re-wire) are enumerated in [`docs/phase-16-rebuild-prereqs.md`](docs/phase-16-rebuild-prereqs.md). See `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` for the full canonical plan.

See [`docs/usage.md`](docs/usage.md) for day-to-day operation, [`CHANGELOG.md`](CHANGELOG.md) for phase history, [`docs/architecture.md`](docs/architecture.md) for the current runtime flow, [`docs/extending.md`](docs/extending.md) for development recipes, [`docs/testing-log-2026-04-27.md`](docs/testing-log-2026-04-27.md) for test and regression history, [`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`](../sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md) for the full maturity-first phase plan, and [`sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md`](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) for the architectural ADR.

## Install on a new machine

The repo is **private** — access is controlled by GitHub SSH permissions. There is no public package registry entry. Two paths:

- **(A) Direct git+SSH install** — fastest, no clone needed. Recommended for users who just want to run `sov`.
- **(B) Source clone + `bun link`** — for contributing or tracking `master` between version bumps.

Both paths register the binary at `~/.bun/bin/sov`. Run only one of them; the latest install wins.

### Prerequisites

| Tool | Needed for |
|---|---|
| **Bun 1.2+** | The runtime itself. Ships `bun:sqlite` with FTS5 compiled in — no native-compile step. |
| **Provider API key** | Anthropic/OpenAI/OpenRouter access, depending on provider. Ollama can run local without a key. |
| **Git + SSH to GitHub** | The repo is private — your SSH key must be authorized on the `yevgetman/sovereign-ai-harness` repo. Same for the docs bundle (`yevgetman/sovereign-ai-docs`) if you want it. |
| **Node 18+** *(optional)* | Only for the **docs-repo** lint / cascade / sync scripts. Not needed to run the harness. |

Install Bun with `curl -fsSL https://bun.sh/install | bash`, then reopen your shell (or `source` your rc) so `~/.bun/bin` ends up on PATH. Get a provider API key at `console.anthropic.com`. Confirm SSH access works with `ssh -T git@github.com`.

### Path A — install directly from the private repo

```bash
# 1. Install or upgrade `sov` from the private repo over SSH.
#    Bun clones into its global cache, runs `bun install`, and links
#    ~/.bun/bin/sov → the cached repo's src/main.ts.
bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git

# 2. Drop your provider key somewhere `sov` will see it
export ANTHROPIC_API_KEY=sk-ant-...           # any login shell
# or persist it in ~/.harness/credentials.json — see docs/usage.md

# 3. Run from anywhere
sov                                           # generic-agent mode, no bundle
sov --bundle ~/code/sovereign-ai-docs         # with the docs bundle (also private)
```

**Upgrade once installed:** `sov upgrade` (or `sov upgrade --ref v0.2.0` to pin to a tag). The subcommand pre-uninstalls, **wipes Bun's install cache** (`~/.bun/install/cache/`), then reinstalls. The cache wipe is the default since 2026-05-05 because Bun's binary manifest cache otherwise pins a stale `URL → SHA` mapping for the harness git URL — `sov upgrade` would silently re-install the same SHA you already had. `--dry-run` prints the bun commands without running them. The first install still uses the explicit `bun install -g git+ssh://…` form above (you can't run `sov upgrade` until `sov` exists).

The cache wipe also evicts other Bun-installed packages' manifests as a side-effect — those regenerate (small one-time slowdown on each package's next install, never broken). If you specifically want to preserve those manifests and accept the risk of a stale upgrade, `sov upgrade --keep-cache` opts out. The legacy `--purge-cache` flag is preserved for back-compat but is now a no-op (it's the default).

Access control is the GitHub SSH key on the user's machine — exactly the same model the source clone uses. Nothing reaches a public registry.

### Path B — clone + `bun link` (development / contributing)

Path A is sufficient for using the harness. Use this path only if you're modifying runtime code or want a working tree with live symlink semantics.

```bash
# 1. Clone both repos
git clone git@github.com:yevgetman/sovereign-ai-harness.git ~/code/sovereign-ai-harness
git clone git@github.com:yevgetman/sovereign-ai-docs.git   ~/code/sovereign-ai-docs

# 2. Install deps + register the global `sov` binary as a live symlink
cd ~/code/sovereign-ai-harness
bun install
bun link     # creates ~/.bun/bin/sov → this repo's src/main.ts

# 3. Drop your provider key into .env (gitignored; auto-loaded from repo root)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 4. Run from anywhere — code edits take effect on the next invocation
sov --bundle ~/code/sovereign-ai-docs
```

`bun link` produces a live symlink to your working tree (edits take effect immediately, no rebuild). Path A's symlink points at the global cache and is replaced on every upgrade.

### What ports vs. what doesn't

**Comes with the repos:** runtime code, tests, ADRs, business docs, CLAUDE.md rules, decisions digest, status pages — every committed file.

**Does not port:**
- `~/.harness/sessions.db` — your conversation history lives under `$HOME`, not the repo. A new machine starts with an empty DB. `scp` the file across if you want a snapshot; usually not worth it.
- `~/.harness/memory/` — bounded `USER.md` / `MEMORY.md` files are local runtime memory. Copy them intentionally if you want the same remembered preferences or notes on another machine.
- `.env` — gitignored by design. Every user brings their own API key.
- The `sovereign-ai-ops` repo (macOS launchd cron for feed / CHANGELOG / audit) — **not required to run the harness.** Clone it only if nightly summaries matter.

### Optional extras

- **Contributing docs changes** — `cd ~/code/sovereign-ai-docs && npm install && npm run install-hooks` turns on the pre-commit cascade + linter.
- **Skip `--bundle` every call** — `export HARNESS_BUNDLE=~/code/sovereign-ai-docs` in your shell rc.
- **Different model** — `sov -m claude-opus-4-7` (default is `claude-haiku-4-5-20251001`).
- **Different provider** — `sov --provider openai -m gpt-4o-mini`, `sov --provider ollama -m qwen2.5:3b`, or `sov --provider openrouter -m anthropic/claude-haiku-4.5`.

### Gotchas

1. **`~/.bun/bin` must be on PATH.** The Bun installer edits your shell rc; a running shell won't see the change until it's reopened or `source`'d.
2. **No `.bun-version` pin yet.** Any Bun 1.2+ has worked in practice; very old Bun versions may have different `bun:sqlite` APIs.
3. **`bun link` is dev-mode, not a production binary.** The symlink points at the live `src/main.ts` — code edits take effect on the next invocation, no rebuild. Production client installs use `bun build --compile` to produce a standalone binary per [ADR H-0003](../sovereign-ai-docs/harness/decisions/0003-claude-code-core-hermes-learning-layer.md) + [agent-harness § deployment-topology](../sovereign-ai-docs/business/architecture/agent-harness.md#deployment-topology).
4. **Node is a soft dep.** Pure runtime users don't need Node at all. It's only for the docs-repo toolchain (lint, cascade, Notion sync).

## Quick usage

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...   # or drop it in .env at the repo root
bun run chat --bundle ~/code/sovereign-ai-docs
# or: HARNESS_BUNDLE=~/code/sovereign-ai-docs bun run chat
```

Flags: `-p, --profile <name>` (top-level — pin the run to `<harness-home>/profiles/<name>/`; use `default` for the unscoped root), `--provider <name>` (default `anthropic`), `--model <name>` (provider/config default if omitted), `--max-tokens <n>` (default `12000`), `--bundle <path>` (or `HARNESS_BUNDLE` env, or auto-resolved from CWD), `--permission-mode <default|ask|bypass>` (default `default`), `--resume <uuid>` (resume a prior session), `--db <path>` (override the default `~/.harness/sessions.db`), `--no-cache` (disable provider prompt-cache markers for testing), `--no-preflight` (skip startup provider health checks), `--transcript <path>` (write a redacted JSONL terminal/event transcript), `-v, --verbose` (show full tool-result preview blocks instead of one-line summaries), `--legacy-input` (force the readline-based input loop instead of the Wave-4 raw-mode editor; safety hatch for terminal-compat issues).

`sov config` — open the interactive picker for user-level config (or `sov config get|set|unset|show|path <args>` to script it).

`sov profile [list|create|use|show|import-default]` — manage profile-scoped state roots. `sov profile create work` makes `<harness-home>/profiles/work/`; `sov profile use work` pins it as the persisted active profile; `sov -p work chat …` is one-shot per-invocation. `sov profile import-default work` copies `<harness-home>/config.json` + `credentials.json` from the default root into the named profile (sessions/trajectories/memory stay clean). The active profile is persisted at `<harness-home>/active-profile`; remove or empty that file (or `sov profile use default`) to fall back to the unscoped root.

See [`docs/usage.md`](docs/usage.md) for provider configuration, resume, context references, permissions, slash commands, memory, skills, compaction, common workflows, and troubleshooting.

### Global `sov` command (dev-mode)

Install once, invoke from anywhere — mirrors how `claude` is invoked for Claude Code:

```bash
cd ~/code/sovereign-ai-harness
bun link         # registers the package AND installs the `sov` binary on PATH
```

Then from any directory:

```bash
sov --bundle ~/code/sovereign-ai-docs
# or set HARNESS_BUNDLE once in your shell rc:
#   export HARNESS_BUNDLE=~/code/sovereign-ai-docs
# and just:
sov
```

The symlink points at `./src/main.ts` so edits under `src/` take effect on the next invocation — no rebuild step. For production (client installs) use `bun build --compile` to produce a standalone binary instead; see [`agent-harness.md § deployment-topology`](../sovereign-ai-docs/business/architecture/agent-harness.md#deployment-topology).

To uninstall: `bun unlink` from the repo root, or `rm ~/.bun/bin/sov`.

## Development

```bash
bun install
bun run test       # fixture tests
bun run lint       # biome
bun run chat --version
```

See `CLAUDE.md` for Claude Code session rules when developing this repo.

## What this repo contains

| Directory | Purpose | Phase |
|---|---|---|
| `src/context/` | System/user context assembly, prompt-cache boundaries, injection defense, context references, subdirectory hints | 6, 6.7 |
| `src/core/` | Async-generator turn loop, content-block types, partition-and-batch orchestrator | 0 scaffold, 1 functional, 4 batched |
| `src/tool/` | `Tool<I,O>` factory with fail-closed defaults; `affectedPaths` + `renderResult` | 0, 4 extensions |
| `src/tools/` | Bash + FileRead/Write/Edit + Grep/Glob + bounded memory tool + skill tools + WebFetch/WebSearch | 2 Bash, 4 file & search, 6.5 memory, 9/9.5 skills, 10.2 web |
| `src/providers/` | LLM provider adapters, resolver, credential pool, rate guard, auxiliary fallback | 1 Anthropic, 5/5.5 hardened |
| `src/permissions/` | Permission middleware (layered rules, ask/default/bypass modes, project-local always rules, shell AST analysis for virtual tool mapping) | 3, 7, Qwen-B |
| `src/agent/` | Session DB — SQLite + WAL + FTS5, migrations, retry wrapper, compaction lineage | 3.5, 10 |
| `src/commands/` | Slash commands (local / local-jsx / prompt) | 8, 10 |
| `src/skills/` | Markdown-plus-frontmatter skill loader, prompt expansion, visibility gates, guard scanner, slash-command adapter | 9/9.5 |
| `src/compact/` | Context-window compaction + microcompaction (per-part tool-result clearing) | 10, Qwen-A |
| `src/hooks/` | Shell-out lifecycle hooks | 11 |
| `src/mcp/` | MCP client | 12 |
| `src/bundle/` | Harness-bundle loader (Sovereign AI specific) | 0 skeleton |
| `src/memory/` | Bounded MEMORY.md / USER.md store, provider ABC, user-message memory injection | 6.5 |
| `src/trajectory/` | JSONL trajectory writer (Hermes pattern) | 13.1 |
| `src/review/` | Background review loop — ReviewManager, runReviewFork, ProposalStore, consolidation, stall detection (Hermes pattern) | 13.3 |
| `src/router/` | Hybrid router — local / local-with-escalation / frontier | 5, 10.6 |
| `src/config/` | Provider config, permission-rule settings loader, and `$HARNESS_HOME` path helpers | 5, 6.5, 7 |
| `src/ui/` | Terminal REPL — splash, footer, modal, picker, diff renderer, theme system, input editor (keypress dispatcher + textBuffer + autocomplete + persistent history) | 0 stub, 1, 10.5b–e |

Empty directories are deliberate — they mark future phase landing zones.

## License

Private. All rights reserved.
