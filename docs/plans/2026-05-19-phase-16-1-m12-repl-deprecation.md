# Phase 16.1 M12 — Readline REPL deprecation warning implementation plan

**Spec:** [`docs/specs/2026-05-19-phase-16-1-m12-repl-deprecation-design.md`](../specs/2026-05-19-phase-16-1-m12-repl-deprecation-design.md)
**Mode:** Pending user authorization.
**Predecessor HEAD:** `96689b6` (backlog #43 close-out).

## Tasks (ordered)

### T1 — `formatReplDeprecationMessage` helper + tests

**Files:**
- `src/cli/replDeprecation.ts` (new, ~40 LoC)
- `tests/cli/replDeprecation.test.ts` (new, ~80 LoC)

**Behavior:** see spec §4.1. Pure function — takes `{ source, env }`, returns warning string or `null` for suppress. Six unit tests covering each `source` value + suppression flag + content invariants (M13 reference, env-var name).

**Commit:** `feat(cli): add formatReplDeprecationMessage helper (M12 T1)`

### T2 — Wire helper into `src/main.ts`

**File:** `src/main.ts` (modified).

**Change:** Add the M12 block right after `const resolution = resolveSurface(...)` (line 214) and BEFORE the missing-binary-fallback check (line 221). Dynamic import pattern matches the existing surfaceResolver import.

**No tests added at this layer** — the helper is unit-tested at T1; the main.ts wiring is verified end-to-end by the boot smoke at T4.

**Commit:** `feat(cli): emit REPL deprecation warning at boot (M12 T2)`

### T3 — Documentation updates

**Files:**
- `README.md` — update `--ui` description + add a short paragraph on `SOV_NO_DEPRECATION_WARNING`.
- `docs/usage.md` — similar treatment.

**Search for `--ui` references in both files; add the deprecation note inline.**

**Commit:** `docs: M12 — note REPL deprecation in README + usage.md`

### T4 — Smoke rerun

**Files:**
- `docs/state/2026-05-19-m12-smoke/` (new directory).
- `docs/state/2026-05-19-m12-smoke/run-smoke.ts` (new, copy-and-extend from `docs/state/2026-05-17-m11-smoke/run-smoke.ts`).
- `docs/state/2026-05-19-m12-smoke/*.transcript.txt` (captured outputs).
- `docs/state/2026-05-19-m12-smoke/README.md` (summary table).

**Scenarios:** mirror the 13 from M11 plus 1-2 new ones:
- Scenario 14: `--ui repl` + `SOV_NO_DEPRECATION_WARNING=1` → REPL boots, deprecation absent.
- Scenario 15: `SOV_UI=repl` → REPL boots, deprecation fires (source=env).

Each scenario's transcript checked into the directory; README table notes which scenarios assert deprecation present vs absent.

**Commit:** `test(smoke): M12 boot-decision scenarios with deprecation messaging`

### T5 — Close-out

**Files:**
- `docs/state/2026-05-19-m12.md` (new) — close-out snapshot mirroring M11/M11.5 format. Scope, suite delta, smoke summary, ADRs M12-01..02 reference, what's open, what's next (M13).
- `CLAUDE.md` + `AGENTS.md` — bump state-doc pointer to the M12 close-out; verify byte-identical mirror.
- `docs/backlog/post-phase-13-4.md` — refresh "Last sync" line; M12 introduces no new backlog items (it closes nothing either — M12 is roadmap discipline, not a backlog burndown).
- `docs/testing-log.md` — append entry covering scope, smoke result, suite delta.
- `DECISIONS.md` — append ADRs M12-01 + M12-02 inline.

**Final steps:**
- `bun run lint && bun run typecheck && bun run test` — all green.
- `bun run tui:build` — Go TUI compiles (defensive; M12 makes no Go changes).
- `git push origin master` — autonomous.
- `sov upgrade` — refresh global binary.

**Commit:** `docs(state): 2026-05-19 — Phase 16.1 M12 close-out (REPL deprecation warning)`

## Estimation

- T1: ~30 min (helper + 6 unit tests).
- T2: ~10 min (one block insertion + verify imports).
- T3: ~15 min (two doc edits).
- T4: ~30 min (port the M11 smoke harness; add 2 new scenarios; capture transcripts).
- T5: ~30 min (close-out snapshot + ADRs + backlog header + testing-log + mirror).

**Total: ~2 focused dispatches in one wall-day** at most. Smaller than M11.5 because there's no new protocol, no new component, no Go changes.

## Verification checkpoints

After each commit:
- `bun run lint && bun run typecheck && bun run test` green.
- For docs-only commits: `diff CLAUDE.md AGENTS.md` returns empty.

Before close-out:
- Manual REPL smoke: launch `sov --ui repl`, expect the deprecation warning followed by the normal REPL boot. Launch `SOV_NO_DEPRECATION_WARNING=1 sov --ui repl`, expect silent boot.
- Manual TUI smoke: launch `sov` (no flags), expect NO deprecation warning and TUI boots normally.

## Risks + open questions

Risks tracked in spec §8. No open questions at plan-time — every decision is recorded in spec §6 (ADRs M12-01, M12-02).
