# Instructions for Claude Code sessions developing this repo

You are working on the **Sovereign AI agent runtime** — TypeScript code, not documents. This repo is a Claude-Code-style harness (per ADR H-0003 in the sister `sovereign-ai-docs` repo) that reads a *harness bundle* (the docs repo, or a client's extracted bundle) and drives an LLM conversation against it.

If you need business context (what Sovereign AI is, what the harness does, why), read it in `~/code/sovereign-ai-docs/` — do not re-learn it here. This repo contains code and code conventions only.

## Session boot (minimal — this is a code repo)

1. This file.
2. `README.md`.
3. `docs/state/2026-05-14.md` — **most recent close-out snapshot** (Phase 16.1 M4 shipped; M0–M3 closed earlier). Read this BEFORE the build plan to know what shipped, what's open in the backlog, and where to start. Replaced each session.
4. `docs/backlog/post-phase-13-4.md` — open backlog items not in the canonical build plan. Smaller follow-ups, polish, deferred trade-offs.
5. `~/code/sovereign-ai-docs/harness/docs/runtime/runtime-scaffold-plan.md` — the Phase-0/1 scaffold contract this repo was seeded against.
6. `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — the canonical remaining phased plan.
7. `~/code/sovereign-ai-docs/harness/docs/reference/agent-harness-design-lessons.md` — unifying design principles and Claude Code reference lessons.
8. `~/code/claude-code/src/` — the architectural reference. Look up specific patterns there when a design question comes up.

## Documentation index

Every doc in this repo, organized by purpose. Read by category, not by directory listing.

### Reference (read on-demand by topic)

| File | What's in it |
|---|---|
| `docs/architecture.md` | Current runtime flow — request lifecycle, system prompt assembly, tool execution, permissions, persistence, sub-agent runtime, microcompaction, default bundle, REPL UX layers, learning + review pipelines, trajectory capture |
| `docs/usage.md` | Day-to-day operation — CLI flags, subcommands, slash command catalog, eval suite, local-model router, profiles, sessions / resume, providers, themes, web tools |
| `docs/extending.md` | Recipes for adding extension points — tools, providers, slash commands, skills, hooks, MCP servers, agent definitions, permission rules, trajectory redaction patterns |
| `docs/semantic-testing.md` | Semantic test framework — judge backends (claude-code, anthropic-api, string-match), driver, when-to-run mapping table, coverage inventory |
| `CHANGELOG.md` | Phase-by-phase release history (root, not in `docs/`). Note: **frozen at Phase 13.3**; CLAUDE.md "Phases" section below is more current |
| `README.md` | Project intro + Status section (root). Status section is the canonical "what's shipped" summary |
| `AGENTS.md` | Mirror of this file (`CLAUDE.md`). Treat as identical content |

### Current state

| File | What's in it |
|---|---|
| `docs/state/2026-05-14.md` | **Canonical current-state snapshot** (HEAD `adc9026`, suite 1873/1873 unit + Go tests green, Phase 16.1 M4 shipped + manual smoke 11/11 complete with 2 regressions caught + fixed in-session). Updated each major-change session |
| `docs/state/archive/2026-05-13.md` | Historical snapshot (Phase 16.1 M0–M3 close-out). Now superseded |
| `docs/state/archive/2026-05-12.md` | Historical snapshot (Phase 16 revert close-out). Now superseded |
| `docs/state/archive/2026-05-11.md` | Historical snapshot (Phase 16.0a close-out). Now superseded |
| `docs/state/archive/2026-05-07.md` | Historical snapshot (Phase 13.4 close-out). Now superseded |

### Backlog and forward-looking plans

| File | What's in it |
|---|---|
| `docs/backlog/post-phase-13-4.md` | Open backlog (1 item: #17 eval-gated auto-promote, P4) |
| `docs/backlog/phase-16-rebuild-prereqs.md` | Forward-looking — 24 subsystems any future Phase 16.1 foreground refactor must re-wire under Rule 1 of the revert retrospective |
| `docs/backlog/archive/phase-10-5.md` | Historical backlog from Phase 10.5 (closed) |
| `docs/backlog/archive/post-phase-10-5-repl.md` | Historical backlog from Phase 10.5 close-out (closed) |

### Postmortems

| File | What's in it |
|---|---|
| `docs/postmortems/2026-05-12-phase-16-revert.md` | **Required reading** before any future foreground-surface refactor. Contains Rules 1-4 governing how to do a foreground rewrite without orphaning subsystems |
| `docs/postmortems/loop-detector-orphaned-tool-use.md` | Specific bug postmortem (loop detector orphaning tool_use blocks) |

### Operational logs

| File | What's in it |
|---|---|
| `docs/testing-log.md` | Append-only testing log (newest-first ordering at the top). Per CLAUDE.md rule, every testing pass must be logged here |

### Specs (point-in-time design notes)

| File | What's in it |
|---|---|
| `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` | **Active design spec** for the Phase 16.1 TUI rebuild (split-process architecture, Go + Bubble Tea, M0–M13 milestones). M0–M3 shipped 2026-05-13; M4–M13 pending plans |
| `docs/specs/2026-05-13-production-harness-roadmap-design.md` | Umbrella roadmap defining the production polish track (Phases 15, 16.1, 18, 19, 20, 21, 22). Phase 14 dropped 2026-05-13 |
| `docs/specs/memory-retrieval-gaps.md` | Spec for memory retrieval enhancements |

### Implementation plans (executed)

`docs/plans/` holds historical implementation plans authored via the `superpowers:writing-plans` skill. All five plans currently in this directory have shipped. Convention: leave in place after execution as a record.

| File | What it planned |
|---|---|
| `docs/plans/2026-05-06-phase-13-2-task-system.md` | Phase 13.2 task system |
| `docs/plans/2026-05-06-phase-13-3-background-review-daemon.md` | Phase 13.3 review daemon |
| `docs/plans/2026-05-06-phase-13-4-instinct-corpus.md` | Phase 13.4 instinct corpus |
| `docs/plans/2026-05-07-memory-project-scoping.md` | Two-tier MEMORY.md routing |
| `docs/plans/2026-05-13-phase-16-1-tui-rebuild.md` | Phase 16.1 M0–M3 (split-process TUI: server skeleton, Go Bubble Tea scaffold, first real turn end-to-end). Shipped 2026-05-13 |
| `docs/plans/2026-05-14-phase-16-1-m4-critical-correctness.md` | Phase 16.1 M4 (on-disk SessionDb, preflight, full M4-supported CLI flag forwarding, TUI hydration on resume). Shipped 2026-05-14 |

**Note for the `superpowers:writing-plans` and `superpowers:brainstorming` skills.** The skill defaults are `docs/superpowers/plans/` and `docs/superpowers/specs/`. **This project overrides those defaults.** Save plans to `docs/plans/YYYY-MM-DD-<feature-name>.md` and specs to `docs/specs/YYYY-MM-DD-<topic>-design.md`. Do NOT create or write under `docs/superpowers/` — that directory has been intentionally removed.

### Source-adjacent READMEs

A few `src/` and `bundle-default/` subdirectories carry their own README — `src/bundle/README.md`, `src/learning/README.md` — for surface-specific context that doesn't belong in the top-level docs.

## Tech stack

- **Runtime:** Bun.
- **Language:** TypeScript, strict mode.
- **Testing:** Bun's built-in test runner.
- **Lint / format:** Biome.
- **Style:** structurally mirrors `~/code/claude-code/` where sensible — look up the reference when in doubt about a pattern.

## Design principles — don't relitigate

Per ADR H-0003 and the docs-repo planning/reference documents, these are locked:

1. **Async-generator turn loop.** `async function* query(): AsyncGenerator<StreamEvent | Message, Terminal>` from day one. Never collapse to Promise-returning.
2. **Content-block internal messages.** `Message` carries an array of `ContentBlock`s (text / thinking / tool_use / tool_result / image). Providers translate at the boundary.
3. **Fail-closed tool defaults.** `buildTool()` spreads defaults first, user overrides last. `isConcurrencySafe` and `isReadOnly` default to `false`.
4. **Per-invocation concurrency.** `isConcurrencySafe(input)` takes the actual arguments, not a class-level flag.
5. **Permissions are transformable.** `checkPermissions` returns `{ behavior, updatedInput?, reason? }` — rules can normalise input, not just gate it.
6. **Segmented cacheable system prompts.** Static to dynamic, ephemeral cache marker at the boundary.
7. **Uniform Tool interface.** MCP tools, sub-agents, native tools, skill invocations — all flow through the same pipe.
8. **Sub-agents are recursion.** An `AgentTool` calls `query()` with a filtered context. No parallel execution engine.
9. **Bundle-as-data contract.** Runtime reads `<bundle>/business/` + `<bundle>/harness/schemas/`, writes `<bundle>/state/`. Never writes to tier-1 or tier-2 content.

When in doubt, read the corresponding section in `~/code/sovereign-ai-docs/harness/docs/reference/agent-harness-design-lessons.md`.

## Repo conventions

- Every tool uses `buildTool()`. No ad-hoc `{ name, call, ... }` objects.
- Every provider implements the `LLMProvider` interface. Don't call provider SDKs from outside `src/providers/`.
- Every `.ts` file has a short header comment naming its one responsibility.
- `.js` extensions in import paths (Bun convention, matches Claude Code).
- Empty directories under `src/` are phase landing zones. Do not delete them.
- No product-specific hardcoding in `src/` — Sovereign-AI-specific content belongs in the bundle. The runtime is supposed to be deployable verbatim to any client.

## Phases — where we are

**Shipped:** Phases 0–13.5 + Phase 16.0a (daemon skeleton, in tree but **dormant** — no foreground subscriber). The Qwen amendment (microcompaction + shell-AST analysis) shipped on schedule. Suite at HEAD: **1809/1809 unit + 57/58 semantic** (1 model-behavior flake unrelated to current work).

**Reverted (2026-05-12):** Phase 16.0b (Ink TUI) and Phase 16.0c (slash dispatch on Ink) were force-rolled back the day after they shipped, after a close-out parity audit surfaced ~24 silently broken subsystems on the new foreground. Two improvements survived: `sov dispatch` (headless slash-command surface, `src/cli/dispatchCommand.ts`) and the `string-match` semantic-judge backend (`tests/semantic/framework/judges/stringMatch.ts`). The Ink work is preserved on `origin/archive/ink-tui-2026-05-12`.

**Next:** **Phase 16.1 — TUI rebuild.** Active per user direction (2026-05-13). Spec: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`. M0–M3 plan: `docs/plans/2026-05-13-phase-16-1-tui-rebuild.md` (shipped 2026-05-13). M4 plan: `docs/plans/2026-05-14-phase-16-1-m4-critical-correctness.md` (shipped 2026-05-14 — critical correctness group: on-disk SessionDb, preflight, full M4-supported CLI flag forwarding, TUI hydration on resume; 3 prereq boxes flipped). Architecture: split process — `sov` (TS) runs an HTTP+SSE server; `sov-tui` (Go + Bubble Tea) is a separate child process that renders the foreground. terminalRepl untouched per Postmortem Rule 1; `--ui tui` is opt-in until parity audit clears the default flip. Phase 14 (distribution) dropped per the 2026-05-13 Phase-14-dropped ADR in DECISIONS.md. Phase 15 (provider breadth) deferred or run in parallel — user's call at the next plan kickoff. M5–M11 pending plans.

For full phase-by-phase narrative + suite deltas + close-out details, read `docs/state/2026-05-14.md`. For prior cycles, the archived `docs/state/archive/2026-05-07.md`, `2026-05-11.md`, `2026-05-12.md`, and `2026-05-13.md` snapshots cover those. For the canonical phase plan and sequencing logic, read `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` and `phase-10x-status.md`. **Required reading before any future foreground refactor:** `docs/postmortems/2026-05-12-phase-16-revert.md` (Rules 1-4).

Each phase should:
- Add one new abstraction or capability.
- Keep the harness running end-to-end throughout (no broken-for-three-days refactors).
- Exercise the new thing in a real scenario before the phase closes.
- Record design choices in `DECISIONS.md` (add when first non-trivial choice comes up).

## Subagent model policy (HARD RULE — non-negotiable)

When dispatching subagents in this repo (Agent tool / Task tool / subagent-driven-development / executing-plans / any task that runs in a sub-context), this rule overrides any default model selection in skills, plugins, or harness defaults.

- **Opus 4.7 is the default and primary driver.** Use it for every subagent that requires reasoning, judgment, design sense, pattern matching across files, security-sensitive code, or anything that touches the runtime (`src/core/`, `src/providers/`, `src/permissions/`, `src/agent/sessionDb.ts`). This includes implementers, reviewers, planners, architects, debugging agents, and code-quality reviewers.
- **Sonnet 4.6 is acceptable only for trivially mechanical, fully specified tasks.** Examples that qualify: a one-line version bump; a docs-only edit where the exact text is given verbatim; tagging an existing artifact; renaming a single identifier across files where the rename target is unambiguous; running a documented build/test command and reporting pass/fail. Examples that do NOT qualify: writing tests, writing implementation, reviewing code, deciding between two patterns, anything where the agent has discretion. Pick Sonnet because the task is *genuinely mechanical*, never to save tokens or speed up output.
- **Never use Haiku.** No exceptions for "simple tasks," "cost," "speed," "small files," or any other rationalization. If you're tempted to pick Haiku, treat it as a signal you've misread the rule — pick Opus.

If a skill or plan template says "use a fast cheap model," interpret that as "Sonnet 4.6 if and only if the task is trivially mechanical, otherwise Opus 4.7." This rule mirrors the global rule in `~/.claude/rules/ecc/common/agents.md` and is restated here so it applies even when the global rules aren't loaded.

For Phase 16.1 specifically (the active TUI rebuild — see `docs/plans/2026-05-13-phase-16-1-tui-rebuild.md`), every implementer subagent runs on Opus. The only tasks that are candidates for Sonnet are the doc-text edits inside M0 (the ADR-text and umbrella-roadmap-text steps where the exact final text is in the plan body — and even then, Opus is acceptable since the work is short).

## Estimating effort and remaining work

**Do NOT use wall-clock weeks or person-weeks** when estimating remaining work. There is no human development team here — this codebase is built exclusively by AI coding agents like you, in this session and future ones. "1-2 weeks" or "M7 takes ~3 weeks" is a meaningless unit because it presumes a calendar-driven development pace that doesn't exist. The same applies to "sprints", "quarters", calendar dates ("by end of Q2"), or anything else assuming a traditional dev team.

Use these proxies instead, in rough order of preference:

- **Sessions** — discrete planning + dispatch + review cycles, scaled like a milestone close-out. M4 (3 prereq boxes, 11 implementer tasks + 8 cleanup passes + 1 final whole-branch review) was ~1 focused session. A small milestone might fit in 1 session; M7 (6 prereq boxes, hardest group) might be 2–3 sessions because of scope.
- **Token-proxy units** — counts of implementer-task dispatches, files touched, or subagent rounds (each round ≈ Opus implementer + spec reviewer + quality reviewer + cleanup). Useful for sub-session granularity.
- **Wall-clock minutes within a session** — fine for short specific tasks ("~30 minutes to wire up X" or "1-2 hours for the full M5 plan"). Acceptable for sub-session work, NOT for milestone-scale estimates.

When reporting on completed work, count what actually happened in these units — e.g., "M4 shipped in one session: 11 implementer tasks, 8 cleanup passes, 1 final review, ~22 subagent dispatches total." Past performance in agent-sessions is the most reliable basis for future estimates; don't translate it back into "engineer-weeks".

If a doc you're updating (state snapshot, plan, spec) contains week-based estimates from earlier sessions, treat them as legacy and rephrase in session/token/dispatch units when you touch the surrounding text.

## Lint before committing

Run `bun run lint`, `bun run typecheck`, and `bun run test` before every commit. All three must pass. Commit atomically — one logical change per commit. This matches the rule in `sovereign-ai-docs/CLAUDE.md`.

(Why all three: `bun run lint` runs Biome which catches style/format issues but does NOT do TypeScript type-checking. `bun run typecheck` runs `tsc --noEmit` and catches things like wrong-scope identifiers and `exactOptionalPropertyTypes` violations that would slip through Biome + Bun's runtime test executor — Bun runs JS-style and doesn't enforce types at test time. Skipping typecheck is how the `settings is not defined` runtime bug in 2026-05-05's Phase 13 commits made it to master.)

## Semantic test suite — when to run, when to extend

`bun run test:semantic` is opt-in (~5 min wall, ~$0.87 informational on subscription). Apply this triage:

- **Doc-only / formatting:** skip
- **Touching one specific surface** (single tool, single slash command, single permission rule path, single context surface): run the matching filter — `bun run test:semantic -- --filter <id-or-substring>`
- **Touching `src/core/query.ts`, `src/providers/`, `src/agent/sessionDb.ts` schema, or `src/permissions/canUseTool.ts`:** run the full suite
- **Before pushing a substantive feature batch to master:** run the full suite
- **Phase completion gate:** run the full suite + log it in `docs/testing-log.md`

When in doubt, run the full suite — five minutes and a dollar of subscription value is cheap insurance.

Add a new semantic test when shipping: a new tool, a new slash command, a new permission rule path, a new context surface, or fixing a bug that should never regress. At phase completion, audit user-visible behaviors and ensure each has at least one case.

**When you change `tests/semantic/suites/`, update [`docs/semantic-testing.md`](docs/semantic-testing.md) in the same commit** — coverage inventory, headline count, and the run-policy mapping table all must stay in sync with reality. If they drift, the triage policy lies.

Full mapping table (changed area → filter) and extension rules: [`docs/semantic-testing.md#when-to-run-and-when-to-extend`](docs/semantic-testing.md#when-to-run-and-when-to-extend).

## Testing log

Append an entry to `docs/testing-log.md` whenever harness testing is performed, whether automated (`bun run test`, lint/typecheck gates, targeted unit tests) or semantic/manual (CLI checks, REPL smoke tests, provider/tool behavior checks). Record the scope, environment, commands, manual coverage, result, and any regressions or follow-ups.

## Commit and push

Same rule as the docs repo: autonomous add / commit / push after every working change. Push target is `origin/master` once the remote is configured.

## Keep the global `sov` binary in sync

After pushing changes that affect the runtime (anything under `src/` or `bundle-default/`), run `sov upgrade` so the global `sov` binary picks up the new master. The user's `sov` is a Path A install (`bun install -g git+ssh://…`) — a cached copy under `~/.bun/install/global/`, NOT a live symlink to this working tree. Without the upgrade step the user keeps running the previous SHA and any test the user runs against `sov` will hit stale code. As of 2026-05-05, `sov upgrade` defaults to wiping Bun's install cache, so it reliably installs latest master in one shot.

Skip the upgrade only when the changes are confined to `tests/`, `docs/`, or other non-runtime paths — those don't affect the binary.

When in doubt, run it. The cost is ~5–10 seconds; the cost of a stale binary is the user thinking they're testing your fix when they're actually testing the previous version.

**Phase 16.1 note:** `sov upgrade` also triggers the package's postinstall hook, which rebuilds `bin/sov-tui` from `packages/tui/`. The TUI binary requires Go ≥ 1.24 on PATH. If Go is missing, the install succeeds and `sov --ui repl` (the default) still works; `sov --ui tui` falls back to repl with a one-line warning. Changes under `packages/tui/` therefore have the same "run `sov upgrade`" obligation as changes under `src/`.

On first install only, Bun's global installer blocks postinstall scripts by default. If `bin/sov-tui` is missing after `bun install -g`, run:

```bash
bun pm -g trust @yevgetman/sov
```

Then re-run `sov upgrade`. Subsequent upgrades pick up the trusted entry automatically.
