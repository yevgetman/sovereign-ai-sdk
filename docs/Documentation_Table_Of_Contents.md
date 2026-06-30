# Documentation Table of Contents

This is the entry point for the Sovereign AI harness documentation set. Use it to orient yourself before reading any individual doc.

The docs describe **the current state of the codebase**. Future-state work — design specs and phased implementation plans — lives in [`/specs/`](../specs/) and [`/plans/`](../plans/) at the repo root, **not** here. (Business/product context lives in the sister `~/code/sovereign-ai-docs/` repo.)

> Read [`How_To_Work_With_Docs.md`](How_To_Work_With_Docs.md) **before** adding, moving, or renaming any doc — it's the procedural manual for this set.

---

## How to read these docs

The directory structure is **progressive**: sections are numbered general → specific. Open docs on demand; don't pre-load the set.

- **Five minutes:** read `01-overview/design-principles.md` + `02-architecture/runtime-architecture.md` (the "Request Flow" section).
- **An hour:** read all of `01`–`02`, then skim `03-cli-reference/usage.md`.
- **Doing a task:** jump to the matching section below (extending → `04`, a convention → `05`, testing → `06`).

Agents and humans both use these docs; the framing is technical and direct.

---

## 01 — Overview

The conceptual frame: what's settled and why.

- [Design principles](01-overview/design-principles.md) — the 9 locked, non-relitigated principles (async-generator turn loop, content-block messages, fail-closed tools, segmented cacheable prompts, sub-agents-as-recursion, bundle-as-data, …).

## 02 — Architecture

How the runtime is built.

- [Runtime architecture](02-architecture/runtime-architecture.md) — request lifecycle, the **SDK substrate** (`createAgent`) every surface runs on + the machine-enforced **open/proprietary boundary** and the `sov-protocol` wire contract, system prompt, tools, permissions, persistence (the injectable `SessionStore` port), sub-agents, microcompaction, REPL/TUI layers, learning + review pipelines, trajectory capture, the OpenAI + native gateway server surfaces (auth, multi-client transport, supervisor, multi-user isolation, channels).
- [Subsystems overview](02-architecture/subsystems-overview.md) — the component-level atlas: every region of the codebase named and placed, with the invariants that hold across them.

## 03 — CLI reference

The command surface and day-to-day operation.

- [Usage guide](03-cli-reference/usage.md) — CLI flags, subcommands, slash commands, the eval suite, the local-model router, profiles, providers, themes, web tools.

## 04 — Extending

Recipes for adding extension points.

- [Extending the harness](04-extending/extending.md) — adding tools, providers, slash commands, skills, hooks, MCP servers, agents, permission rules, workflows, semantic tests, and trajectory redaction.

## 05 — Conventions

Patterns and standing rules contributors must follow. (These are the operating conventions the router links as "read before you do X".)

- [Autonomous feature builds](05-conventions/autonomous-feature-builds.md) — **the inherited apex SOP-12 build procedure**: spec → CEO green-light → autonomous subagent build → docs + tests → ship.
- [Lint and commit](05-conventions/lint-and-commit.md) — `lint` / `typecheck` / `test` all required before any commit; atomic commits; push autonomously.
- [Cutting releases](05-conventions/cutting-releases.md) — cut the next binary release in the same session after any `src/` / `bundle-default/` / `packages/tui/` change.
- [`sov` upgrade](05-conventions/sov-upgrade.md) — keep the global `sov` binary current after a runtime/TUI change.
- [Estimation](05-conventions/estimation.md) — quote effort in sessions / dispatches / wall-minutes, never weeks.
- [Repo layout](05-conventions/repo-layout.md) — where files go in `src/`, how to name a plan/spec, how to move things.
- [Subagent policy](05-conventions/subagent-policy.md) — the hard rule on Opus / Sonnet / never-Haiku for dispatched subagents.
- [Semantic tests](05-conventions/semantic-tests.md) — when and how to run `bun run test:semantic`.
- [Testing-log obligation](05-conventions/testing-log.md) — the append-an-entry-when-you-test rule (the log itself is in `06-testing/`).
- [TUI style guide](05-conventions/tui-style-guide.md) — all spacing/borders/glyphs/colors/type come from `style.S.*`; never hardcode layout in components.
- [TUI color rendering](05-conventions/tui-color-rendering.md) — body text inherits the terminal default; don't assume a hex/ANSI value renders bright.
- [TUI UX patterns](05-conventions/tui-ux-patterns.md) — flow layout, splash, spinner, separators, tool events, file-ref wrap, prompt/status styling.
- [Visual TUI QA](05-conventions/visual-tui-qa.md) — drive `sov-tui` via VHS, render PNG screenshots, `Read` the result (`bun run visual`).

## 06 — Testing

The semantic-test framework and the running log.

- [Semantic testing](06-testing/semantic-testing.md) — judge backends, suites, the coverage inventory, and how test categories map to bug classes.
- [Testing log](06-testing/testing-log.md) — the append-only, newest-first record of every test run, finding, and design-error postmortem.

## 07 — History

Audits, postmortems, and the chronological state-snapshot series. These are records, not authoritative current-state — read the newest snapshot for "where we are."

- **Audits** (`07-history/audits/`)
  - [2026-06-10 — full-codebase audit](07-history/audits/2026-06-10-full-codebase-audit.md) — 21-area + 3-holistic sweep; all confirmed Critical/High fixed.
  - [2026-06-14 — post-audit bug hunt](07-history/audits/2026-06-14-post-audit-bug-hunt.md) — second deep-dive on the least-reviewed code; 46 findings, all fixed.
- **Postmortems** (`07-history/postmortems/`)
  - [Phase 16 revert](07-history/postmortems/2026-05-12-phase-16-revert.md) — the written-down lesson from the revert.
  - [Loop-detector orphaned tool_use](07-history/postmortems/loop-detector-orphaned-tool-use.md) — bug write-up + resolution.
- **State snapshots** (`07-history/state/`) — one close-out snapshot per shipped unit, newest-first. The latest is the canonical "current state." Find it with `ls docs/07-history/state/*.md | sort -r | head -1`. Most recent: [SDK open-core extraction](07-history/state/2026-06-30-sdk-open-core-extraction.md) — the harness now runs on `createAgent`. Pre-Phase-16 history is in [`07-history/state/archive/`](07-history/state/archive/). Smoke/soak output (transcripts) sits in the dated `*-smoke/` and `*-soak/` subdirs.

## 08 — Roadmap

Forward-looking but **not** committed (committed future-state is in `/specs/` + `/plans/`).

- [SDK extraction — deferred work](08-roadmap/sdk-extraction-deferred-work.md) — what the open-core SDK inversion intentionally left for later (the physical `packages/` monorepo split + package publish, Node compatibility, SDK-docs polish).
- **Backlog** (`08-roadmap/backlog/`)
  - [Post-Phase-13.4 backlog](08-roadmap/backlog/post-phase-13-4.md) — open items not in the canonical build plan (the record of truth for follow-ups). Plus the "last sync" running log.
  - [Phase-16 rebuild prerequisites](08-roadmap/backlog/phase-16-rebuild-prereqs.md) — the 24 subsystems the foreground TUI rebuild had to re-wire (24/24 complete).
  - Archived backlogs in [`08-roadmap/backlog/archive/`](08-roadmap/backlog/archive/).
- **Candidates** (`08-roadmap/candidates/`) — ideas past "random thought" but deliberately **not** scheduled. [README](08-roadmap/candidates/README.md) explains the lifecycle; current candidates: [authored instincts](08-roadmap/candidates/authored-instincts.md), [GateGuard pre-edit gate](08-roadmap/candidates/gateguard-edit-gate.md).

---

## Future-state (separate, at repo root)

Per SOP-13, design specs and implementation plans are **not** in `docs/` — they describe what *will be*, not what *is*:

- [`/specs/`](../specs/) — design specs (one dated `*-design.md` per feature; ~38 docs). The pre-implementation contract for a feature.
- [`/plans/`](../plans/) — phased, milestoned implementation plans (~42 docs). The scheduled work.

When a plan ships, its design intent lands in `docs/` (and a `07-history/state/` snapshot) in the same wave; the spec/plan stay in `/specs` and `/plans` as the historical record.

---

## Quick navigation

| I want to … | Start here |
|---|---|
| Understand the engine fast | [Runtime architecture](02-architecture/runtime-architecture.md) |
| Know what's settled / non-negotiable | [Design principles](01-overview/design-principles.md) |
| Run or operate `sov` | [Usage guide](03-cli-reference/usage.md) |
| Add a tool / provider / command / agent | [Extending](04-extending/extending.md) |
| Build a feature the right way | [Autonomous feature builds (SOP-12)](05-conventions/autonomous-feature-builds.md) |
| Commit / release correctly | [Lint and commit](05-conventions/lint-and-commit.md) · [Cutting releases](05-conventions/cutting-releases.md) |
| See where we are now | newest in [`07-history/state/`](07-history/state/) |
| Find a feature's design intent | [`/specs/`](../specs/) + [`/plans/`](../plans/) |

---

## Cross-references

- [How to work with the docs](How_To_Work_With_Docs.md) — the procedural manual (placement, naming, the cross-doc impact scan)
- [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) — the lean root router (purpose, standing rules, session boot)
- [`README.md`](../README.md) — repo intro, install, top-level layout
