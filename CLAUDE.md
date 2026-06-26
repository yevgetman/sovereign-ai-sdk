# Instructions for Claude Code sessions developing this repo

You are working on the **Sovereign AI agent runtime** — TypeScript code, not documents. This repo is a Claude-Code-style harness (per ADR H-0003 in the sister `sovereign-ai-docs` repo) that reads a *harness bundle* (the docs repo, or a client's extracted bundle) and drives an LLM conversation against it.

Business/product context lives in `~/code/sovereign-ai-docs/`. This repo contains code and code conventions only.

This file is a **lean router** — purpose, standing rules, and the session-boot order. The full documentation map is **[`docs/Documentation_Table_Of_Contents.md`](docs/Documentation_Table_Of_Contents.md)** (sections ordered general → specific; open docs on demand, don't pre-load). Procedure for working *on* the docs: [`docs/How_To_Work_With_Docs.md`](docs/How_To_Work_With_Docs.md).

---

## ⚠️ ACTIVE FOCUS — Learning-loop soak (TEMPORARY — the founder will say when to remove this)

**Read this first. For the next several sessions the learning loop is the #1 thing in motion — keep it front of mind during all work, whatever the task.**

**What's live (harness v0.6.16, 2026-06-04):** the learning loop is **closed and running by default**. The portable four-port learning layer (`src/learning-layer/` — Observe / Recall / Reason / Persist, per ADR H-0010) is wired into the runtime:
- **Recall is ON by default** (`learning.recall.enabled`): before each turn (server / TUI / `sov drive`), relevant synthesized *instincts* are spliced into the latest user message as a `<learned-context>` block. Fail-open; a no-op when the corpus is empty.
- **Capture + synthesis are ON** (`learning.disabled: false`): tool use is observed every session; synthesis runs in the background and writes instincts to the corpus.

**Proven vs not (be precise):** Phase 1 cleared the spike's *scripted-scenario* bar — a recalled lesson measurably changes behavior (5/5 curated scenarios, **3/3 reps each, 0 regressions, 0 variance**; one full end-to-end run; real-corpus synthesis yields useful instincts). That proves the **mechanism under controlled conditions — NOT real-world or longitudinal value.** **This soak exists to test exactly that:** does the loop actually help in real day-to-day use as the corpus accrues depth? Do not describe it as "proven" beyond the mechanism.

**What to look for during normal work — and surface to the founder:**
- **Did recall help or hurt?** If a `<learned-context>` block was injected, was the instinct relevant + correct, and did it change what you did for better or worse? Flag any recall that was irrelevant, stale, wrong, or harmful.
- **Synthesis quality:** when instincts get synthesized, are they specific + correct or trivial/noisy? (Known caveat: cluster keys are coarse — the synthesizer LLM carries the specificity.)
- **Corpus growth + depth:** `sov learning status`. (Known caveat: only one project has real depth so far — payoff stays thin until depth accrues.)
- Anything surprising about the loop's behavior. **Record observations in `docs/06-testing/testing-log.md`** and tell the founder.

**Do NOT:** disable recall or learning (they are intentionally on for the soak); decide the founder-reserved calls — the **Phase-2 rented engine** (TS-vs-Python is a *major* decision), the **go/no-go**, or **auto-promote-by-default**.

**Deeper context:** state snapshot `docs/07-history/state/2026-06-04-learning-loop-spike-phase-1.md` · spec `specs/2026-06-03-portable-learning-layer-adapter-1-design.md` · plan `plans/2026-06-03-learning-loop-spike-phase-1.md` · evals `bun run eval:learning` + `bun run eval:synthesis-audit` · canonical open-question `learning-loop-closure-and-proof` (still **OPEN**) in `~/code/sovereign-ai-docs`.

---

## Session boot

1. **This file** (`CLAUDE.md`) — router and standing rules.
2. **[`README.md`](README.md)** — repo intro, install, layout.
3. **The latest state snapshot** — the canonical "where we are now." Find it with `ls docs/07-history/state/*.md | sort -r | head -1` (currently `docs/07-history/state/2026-06-09-plugin-system-v1.md` — Plugin System v1, release v0.6.35; it also catches up the un-snapshotted post-Phase-F wave). Predecessors are dated siblings; pre-Phase-16 history is in `docs/07-history/state/archive/`.
4. **[`docs/08-roadmap/backlog/post-phase-13-4.md`](docs/08-roadmap/backlog/post-phase-13-4.md)** — open backlog items not in the canonical build plan (+ the running "last sync" log).
5. **`~/code/sovereign-ai-docs/harness/docs/runtime/runtime-scaffold-plan.md`** — Phase-0/1 scaffold contract this repo was seeded against.
6. **`~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`** — canonical remaining phased plan.
7. **`~/code/sovereign-ai-docs/harness/docs/reference/agent-harness-design-lessons.md`** — unifying design principles and Claude Code reference lessons.

`~/code/claude-code/src/` is the architectural reference. Look up specific patterns there when a design question comes up.

---

## Documentation

Everything is indexed in **[`docs/Documentation_Table_Of_Contents.md`](docs/Documentation_Table_Of_Contents.md)**. Load on demand — don't read the whole set at boot. The shape:

| Section | What's in it | Reach for it when |
|---|---|---|
| [`docs/01-overview/`](docs/01-overview/) | The 9 locked design principles | You're tempted to relitigate a settled decision |
| [`docs/02-architecture/`](docs/02-architecture/) | Runtime architecture + the subsystem atlas | You need the request lifecycle or "where does X live" |
| [`docs/03-cli-reference/`](docs/03-cli-reference/) | The usage guide (CLI/slash/eval/providers) | You're operating or driving `sov` |
| [`docs/04-extending/`](docs/04-extending/) | Recipes for tools/providers/commands/agents/tests | You're adding an extension point |
| [`docs/05-conventions/`](docs/05-conventions/) | The standing operating conventions | Before a build, a commit, a release, or TUI visual work |
| [`docs/06-testing/`](docs/06-testing/) | Semantic-test framework + the append-only log | You're testing |
| [`docs/07-history/`](docs/07-history/) | Audits, postmortems, dated state snapshots | You need a record or current state |
| [`docs/08-roadmap/`](docs/08-roadmap/) | Backlog + unscheduled candidates | You're picking up follow-up work |

**Future-state is separate** (per SOP-13): design specs in [`specs/`](specs/) and phased plans in [`plans/`](plans/) at the repo root — `docs/` is current state only.

---

## Hard rules

These apply every session and override defaults:

- **Autonomous feature builds** — code builds follow the inherited apex **SOP-12**: spec → **CEO green-light** → autonomous subagent build → docs + tests → ship. Self-review the spec, then **present it to the CEO and PAUSE for an explicit green-light** (the one human gate — never self-approved, never skipped). On green-light: write the plan and execute it **fully autonomously** (fresh subagent per task, review between tasks, no further approval pauses; fix issues with judgment + prudence); update docs + tests; run the gate; commit + push; `sov upgrade` + agent skills + cut a release when applicable. CEO-reserved/strategic decisions and destructive/outward actions still pause. Details: [`docs/05-conventions/autonomous-feature-builds.md`](docs/05-conventions/autonomous-feature-builds.md).
- **Subagent model policy** — Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; **never Haiku**. Details: [`docs/05-conventions/subagent-policy.md`](docs/05-conventions/subagent-policy.md).
- **Pre-commit gate** — `bun run lint && bun run typecheck && bun run test`. All three. Details: [`docs/05-conventions/lint-and-commit.md`](docs/05-conventions/lint-and-commit.md).
- **Atomic commits + autonomous push** — one logical change per commit; push `origin/master` without asking. Same rule as the docs repo.
- **`sov upgrade` after runtime changes** — any `src/`, `bundle-default/`, or `packages/tui/` change. Details: [`docs/05-conventions/sov-upgrade.md`](docs/05-conventions/sov-upgrade.md).
- **Testing log obligation** — append to `docs/06-testing/testing-log.md` for every testing pass. Details: [`docs/05-conventions/testing-log.md`](docs/05-conventions/testing-log.md).
- **No week-based estimates** — sessions / dispatches / wall-minutes only. Details: [`docs/05-conventions/estimation.md`](docs/05-conventions/estimation.md).
- **TUI style guide** — all spacing, padding, glyphs, brand colors, and typography in `packages/tui/` MUST reference `style.S.*` from `packages/tui/internal/style/`. Never hardcode layout values in components. Details: [`docs/05-conventions/tui-style-guide.md`](docs/05-conventions/tui-style-guide.md).
- **Plans and specs paths** — `plans/YYYY-MM-DD-<feature>.md`, `specs/YYYY-MM-DD-<topic>-design.md` (repo root, not under `docs/`). Never `docs/superpowers/`.
- **AGENTS.md ≡ CLAUDE.md** — byte-identical mirror. Verify with `diff` before commit.

## Required reading before similar work

| File | When to read |
|---|---|
| [`docs/07-history/postmortems/2026-05-12-phase-16-revert.md`](docs/07-history/postmortems/2026-05-12-phase-16-revert.md) | **Before any future foreground-surface refactor.** Rules 1–4. |
| [`docs/07-history/postmortems/loop-detector-orphaned-tool-use.md`](docs/07-history/postmortems/loop-detector-orphaned-tool-use.md) | When debugging tool_use/tool_result lifecycle bugs. |

The `src/bundle/` subdirectory carries its own `src/bundle/README.md` for surface-specific context that doesn't belong in the top-level docs.

## Don't

- Don't relitigate the 9 locked design principles ([`docs/01-overview/design-principles.md`](docs/01-overview/design-principles.md)).
- Don't put product-specific content under `src/` — Sovereign-AI-specific content belongs in the bundle.
- Don't delete empty `src/` subdirectories — they mark phase landing zones.
- Don't bypass the pre-commit gate with `--no-verify` unless you can name why.
- Don't dump content into `CLAUDE.md` — extend a conventions file and link to it.
