# How to work with the docs

This file is the operating manual for the documentation set. Read it **before** adding, editing, moving, or deleting any doc.

Pair it with [`Documentation_Table_Of_Contents.md`](Documentation_Table_Of_Contents.md) (the index of what exists). This file is the procedural counterpart — the how, not the inventory.

The set follows **SOP-13 (progressive-disclosure documentation)**: a lean root router (`CLAUDE.md` / `AGENTS.md`), a master TOC, and purpose-named numbered sections ordered general → specific.

---

## Rule 1 — Place new docs in the right section

Use the section's **purpose**, not the doc's filename, to decide where it goes.

| Section | Holds | Pick this when the doc … |
|---------|-------|--------------------------|
| `01-overview/` | What's settled and why | States a principle, frames the system, argues a locked decision |
| `02-architecture/` | How the runtime is built | Describes a control/data flow, an invariant, a subsystem boundary |
| `03-cli-reference/` | The command surface | Documents a command, flag, subcommand, slash command, or output |
| `04-extending/` | How to add an extension point | Walks through adding a tool/provider/command/agent/hook/test |
| `05-conventions/` | Patterns + standing rules | Establishes a rule other contributors must follow |
| `06-testing/` | Testing framework + the log | Covers semantic tests, judges, coverage, or the append-only run log |
| `07-history/` | Records | An audit, a postmortem, or a dated state snapshot |
| `08-roadmap/` | Uncommitted forward-looking | A backlog item or an unscheduled candidate idea |

**Current state vs. future state.** `docs/` describes what **is**. Design specs and implementation plans describe what **will be** — they live in [`/specs/`](../specs/) and [`/plans/`](../plans/) at the repo root, never in `docs/`. Don't conflate them; readers rely on the separation to know whether a doc is authoritative current-state or aspirational.

---

## Rule 2 — Create a new subdirectory only when the section's shape demands it

Dropping a file directly in an existing section is correct ~95% of the time. Create a new subdirectory only when **all three** hold:

1. You can name three concrete docs that belong in it (not "this one plus future stuff").
2. Its purpose fits one sentence that doesn't overlap an existing section.
3. The existing section would feel structurally wrong if the docs were merged in.

Don't add new **top-level numbered sections** without a deliberate, separate discussion. When you do create a subdirectory, add it to the TOC, and add a `README.md` at its root if it holds more than four files.

---

## Rule 3 — Every doc change triggers a cross-doc impact scan

Before committing, scan for docs your change affects. The fast tool:

```
grep -rln "<old-path-or-phrase>" docs/ specs/ plans/ CLAUDE.md AGENTS.md README.md src/ tests/
```

| If your change … | Then also check … |
|------------------|-------------------|
| Renamed/moved/deleted a doc | Every grep hit above. Update the TOC. Watch for **functional reads in code** — some tests read doc paths (e.g. `tests/docsDefaults.test.ts`, the `*Smoke.test.ts` `SOAK_DIR`s). |
| Added a doc | The TOC (under the right section) + the closest sibling docs. |
| Changed a command/flag/behavior | `03-cli-reference/usage.md`, the relevant `04-extending` recipe. |
| Changed a load-bearing invariant or principle | `01-overview/design-principles.md`, `02-architecture/`, and `CLAUDE.md`/`AGENTS.md` if it belongs in the agent fast-context. |
| Shipped a feature | Land the `docs/` updates **and** a `07-history/state/` snapshot in the same wave; the spec/plan stay in `/specs` + `/plans`. |

A doc out of sync with the code is worse than no doc. Prune stale content rather than leaving it.

---

## Rule 4 — Naming and structure

- **Filenames** are kebab-case ASCII (`runtime-architecture.md`, `cutting-releases.md`). The two root index files are the exception (TitleSnake_Case, so they stand out): `Documentation_Table_Of_Contents.md` and `How_To_Work_With_Docs.md`.
- **Headings.** Top-level `# Title` matches the subject. Use `---` to separate major sections in a long doc.
- **Internal references** use repo-root-relative paths (`docs/02-architecture/runtime-architecture.md`, `specs/<name>.md`, `tests/...`) — the convention the rest of the repo and the agents resolve from. The TOC and these two index files use clickable relative links because they sit at `docs/` root.
- **End every doc with a "Read next" / "Cross-references" block** — 2–5 related links. That's the navigation that makes the set traversable without re-opening the TOC.
- **Length.** Aim for 100–400 lines; split above 800. Many small focused docs beat a few long ones.

---

## Rule 5 — Update the TOC when adding/removing/renaming

[`Documentation_Table_Of_Contents.md`](Documentation_Table_Of_Contents.md) is the master index. Evergreen docs (sections 01–06) are listed individually; the dated archives (`07-history/state/`, `/specs`, `/plans`) are indexed by series + pointer, since they're self-describing and chronological. When you add/remove/rename an evergreen doc, update its bullet and re-check the section still flows general → specific.

---

## Checklist before committing doc changes

```
- [ ] Doc is in the right section (Rule 1), current-state in docs/ and future-state in /specs or /plans
- [ ] New subdirectory (if any) justified by Rule 2
- [ ] Cross-doc impact scan run, including functional path reads in code (Rule 3)
- [ ] kebab-case filename, "Read next" block, 100–400 lines (Rule 4)
- [ ] TOC updated if an evergreen doc was added/removed/renamed (Rule 5)
- [ ] Docs land in the same commit/wave as the code they describe
```

---

## Cross-references

- [Documentation Table of Contents](Documentation_Table_Of_Contents.md) — what exists
- [Autonomous feature builds (SOP-12)](05-conventions/autonomous-feature-builds.md) — the build procedure docs land inside
- [Lint and commit](05-conventions/lint-and-commit.md) — the commit gate
- [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) — the lean root router
