# Phase 16.1 M13 — terminalRepl removal design

**Date:** 2026-05-19
**Status:** Approved. Four ADRs locked (M13-01..04). Execution-ready.
**Predecessor:** [M12 close-out snapshot](docs/07-history/state/2026-05-19-m12.md) — REPL deprecation warning shipped; suite green at 2073/2073; 6/6 smoke pass.
**Driver:** M11 ADR M11-03 + M12 close-out — M11 flipped the default to TUI; M11.5 closed the feature gaps that blocked deprecation; M12 started the deprecation clock. M13 removes the readline surface entirely.

**No-active-users context:** The harness has no production users besides the author. The simpler ADRs in §5 reflect that — no migration-politeness code for users who don't exist. Postmortem Rule 1's "deprecation soak" rationale exists to protect downstream consumers mid-flight; without consumers, the soak gate doesn't apply.

## 1. Purpose

Delete `src/ui/terminalRepl.ts` (2334 LoC) and the readline-only helper modules it composes, plus the M12 deprecation infrastructure that points at it. Simplify the main.ts boot flow to a single foreground surface (the Go TUI). Drop the `--ui` flag, the `SOV_UI` env var, the `ui.surface` config field, and `src/cli/surfaceResolver.ts` — once there's one valid surface, the resolver is dead code.

## 2. Scope

**In scope (M13):**
- Delete `src/ui/terminalRepl.ts` outright.
- Delete the 9 REPL-only `src/ui/*.ts` modules + their orphaned tests (list in §4.2).
- Trim `src/permissions/prompt.ts` to drop `buildReadlineAsker` + `parseAskResponse` (their only consumer was terminalRepl); preserve `serializeAskUser` + `previewToolInput` because `canUseTool.ts` still uses them.
- Delete `src/cli/replDeprecation.ts` + `tests/cli/replDeprecation.test.ts` (self-cancelling — the warning has no surface to warn about).
- Simplify the main.ts boot flow per the three decisions in §5.
- Update `Settings` schema (`src/config/schema.ts`) per decision D2.
- Update `CLAUDE.md` boot block, `README.md`, `docs/03-cli-reference/usage.md` to drop REPL references.
- One-pass sweep of code comments that reference `terminalRepl.ts:NNN` (17 src files; most are "mirrors terminalRepl.ts:402-405"-style historical pointers — replace with prose or delete).
- New state snapshot `docs/07-history/state/YYYY-MM-DD-m13.md`.
- 2–3 new ADRs in `DECISIONS.md` per §5.
- Independent parity audit per Postmortem Rule 3.

**Out of scope:**
- Any change to the Go TUI (`packages/tui/`). M13 is server-side and CLI-side only.
- Any change to the dispatcher / headless `sov dispatch` mode.
- Any change to the `sov chat` deprecated subcommand (separate deprecation thread).
- New TUI features. M13 is pure deletion + rewiring.
- Re-architecture of `permissions/prompt.ts`. Just remove the readline-using exports.

## 3. Soak gate (waived)

Postmortem Rule 1 — "remove deprecated paths only after a defined deprecation period has elapsed" — exists to protect downstream consumers from mid-flight breakage. With no active users besides the author, the rule's rationale doesn't apply. M13 ships immediately after M12 with the parity audit (§10) and smoke (§9) acting as the only safety net.

The author retains the option to re-impose a soak gate before M13 lands if real-use feedback warrants it.

## 4. Deletion map

### 4.1 Primary file

**`src/ui/terminalRepl.ts`** — 2334 lines. Zero code importers (only `src/main.ts:253` dynamically imports it). The single grep hit in `src/server/runtime.ts:729` is a comment reference, not an import.

### 4.2 REPL-only `src/ui/*` modules (orphaned by M13)

Each of these has the REPL as its only non-test importer — confirmed by grep — so the module + its test file both go:

| Module | Test file | Why orphaned |
|---|---|---|
| `src/ui/bracketedPaste.ts` | `tests/ui/bracketedPaste.test.ts` | terminalRepl-only paste handling |
| `src/ui/inlineShell.ts` | `tests/ui/inlineShell.test.ts` | terminalRepl-only `!cmd` shell escape |
| `src/ui/inputEditor.ts` | `tests/ui/inputEditor.test.ts` | terminalRepl-only readline editor |
| `src/ui/markdownStream.ts` | `tests/ui/markdownStream.test.ts` | terminalRepl-only streaming markdown |
| `src/ui/queuedQuestion.ts` | `tests/ui/queuedQuestion.test.ts` | terminalRepl-only readline question queue |
| `src/ui/terminalMessages.ts` | `tests/ui/terminalMessages.test.ts` | terminalRepl-only formatted stderr |
| `src/ui/thinking.ts` | `tests/ui/thinking.test.ts` | terminalRepl-only spinner |
| `src/ui/toolSlot.ts` | `tests/ui/toolSlot.test.ts` | terminalRepl-only compact tool slot |
| `src/ui/transcript.ts` | `tests/ui/transcript.test.ts` | terminalRepl-only transcript logger |

### 4.3 Shared `src/ui/*` modules (keep)

These are imported by terminalRepl AND by other live consumers — they survive M13 untouched:

`contextMeter`, `diff`, `footer`, `inputHistory`, `keypress`, `sessionSummary`, `splash`, `theme`, `modal`, `autocomplete`, `box`, `configMenu`, `picker`, `textBuffer`, `toolFooter`.

Note: `theme.ts` has 14 non-REPL importers (server, configMenu, picker, modal, etc.) — definitely keeps. Any "REPL-coupled" theme call sites disappear naturally when terminalRepl is deleted.

### 4.4 Permissions readline asker

`src/permissions/prompt.ts` currently exports four things:

| Export | Consumer | Action |
|---|---|---|
| `buildReadlineAsker` | terminalRepl only | **delete** |
| `parseAskResponse` | `buildReadlineAsker` + test only | **delete** (orphaned with `buildReadlineAsker`) |
| `serializeAskUser` | `canUseTool.ts` ← live | **keep** |
| `previewToolInput` | `canUseTool.ts` ← live | **keep** |

Plus the `import { type ModalRow, withModal } from '../ui/modal.js'` line — drop with `buildReadlineAsker`. Drop the matching test cases in `tests/permissions/prompt.test.ts:96+` (the `describe('buildReadlineAsker', ...)` block).

The surviving prompt.ts is small and focused — just the askUser serializer + preview helper. No further refactoring.

### 4.5 M12 deprecation infrastructure

- `src/cli/replDeprecation.ts` — delete.
- `tests/cli/replDeprecation.test.ts` — delete.
- `src/main.ts:216-228` — the warning-emission block — delete.

### 4.6 main.ts boot flow

Today (post-M12), `src/main.ts:207-271` is:

```
1. resolveSurface(...) → { surface, source }
2. if surface === 'repl': emit M12 deprecation warning
3. effectiveSurface = surface
4. if effectiveSurface === 'tui' && sov-tui missing: stderr warn + fall back to 'repl'
5. if effectiveSurface === 'tui': runTuiLauncher; exit
6. else: runRepl(...)
```

After M13 (with D1/D2/D3 settled — see §5):

```
1. (optional, per D3) validate --ui flag / SOV_UI value; warn-and-narrow if not 'tui'
2. (optional, per D2) check Settings.ui?.surface; warn-and-narrow if 'repl'
3. if sov-tui missing: hard error with install command + exit 1   [D1=a]
4. runTuiLauncher; exit
```

The boot path shrinks from ~65 lines to ~15 lines.

## 5. ADRs (locked)

The four decisions below are locked. Given no-active-users, migration-politeness code is cut.

### ADR M13-01 — Missing-binary fallback = hard error

**Decision:** When `sov` boots and `findTuiBinary()` returns null, emit a one-line stderr message with the install command and exit code 1. No fallback surface.

**Rationale:** With the REPL gone, there's nothing to fall back to. Hard-erroring is the only honest behavior. The install command is already worded in `src/cli/tuiLauncher.ts`'s error path — M13 just plumbs it into main.ts as a non-recoverable boot failure.

**Behavior:**
```
$ sov
sov: sov-tui binary not found. Install with:
     bun pm -g trust @yevgetman/sov && sov upgrade
$ echo $?
1
```

### ADR M13-02 — Drop `ui.surface` from config schema

**Decision:** Remove the `surface: z.enum(['tui', 'repl']).optional()` field at `src/config/schema.ts:106-107` from the `UiSchema`. The broader `ui` object (theme, footer, diffRender, contextMeter, toolOutput) stays.

**Rationale:** With one valid surface, the field carries no information. Zod's `.strict()` mode on `UiSchema` means existing configs with `ui.surface: "repl"` will fail to parse — that's fine; the author edits their own config. No migration preprocessor.

**Side effect:** Test `tests/config/schema.test.ts:79-82` (which exercises both `'tui'` and `'repl'` as valid surface values) gets deleted with the field.

### ADR M13-03 — Drop `--ui` flag + `SOV_UI` env handling entirely

**Decision:** Remove `.option('--ui <surface>', ...)` at `src/main.ts:182`. Remove all `SOV_UI` env reads. Remove `SOV_NO_DEPRECATION_WARNING` env handling (only the deprecation warning used it).

**Rationale:** Cleaner CLI surface. The `--ui` flag never had a non-default valid value besides `repl`, which is gone. `SOV_UI=tui` is redundant with the new default. Author can update shell rc.

### ADR M13-04 — Delete `src/cli/surfaceResolver.ts` outright

**Decision:** Delete the surface resolver and its test. Replace the one main.ts call site with a direct `findTuiBinary()` check.

**Rationale:** A resolver that resolves to one value isn't a resolver. The 77-line module + 178-line test become dead code.

## 6. New main.ts boot flow (post-M13)

```ts
program
  .action(async (opts) => {
    // 'sov chat' deprecation notice (unchanged, separate thread)
    if (process.argv[2] === 'chat') {
      process.stderr.write(
        "[deprecated] 'sov chat' is going away — use bare 'sov' for the interactive REPL, or 'sov dispatch' for headless slash-command testing.\n",
      );
    }

    const { findTuiBinary, runTuiLauncher } = await import('./cli/tuiLauncher.js');
    if (findTuiBinary() === null) {
      process.stderr.write('sov: sov-tui binary not found. Install with:\n');
      process.stderr.write('     bun pm -g trust @yevgetman/sov && sov upgrade\n');
      process.exit(1);
    }

    const code = await runTuiLauncher(opts);
    process.exit(code);
  });
```

~13 lines, down from ~65. No surface resolution, no deprecation warning, no readline fallback, no `--ui` flag handling.

Note: the `sov chat` subcommand's deprecation message is a separate thread (introduced pre-M11) and untouched by M13. It can be revisited in a later cleanup pass.

## 7. Test surface after M13

**Deleted entirely:**
- 9 `tests/ui/*.test.ts` files for the orphaned modules (§4.2).
- `tests/cli/replDeprecation.test.ts`.
- `tests/cli/surfaceResolver.test.ts`.
- The `describe('buildReadlineAsker', ...)` block in `tests/permissions/prompt.test.ts` (parser-only tests survive if any remain after pruning).
- Test case at `tests/config/schema.test.ts:79-82` exercising `ui.surface` validation.

**Updated:**
- `tests/cli/tuiLauncher.test.ts` + `tests/cli/tuiLauncherIntegration.test.ts` — cases that asserted the REPL-fallback path now assert hard-error (exit 1 + stderr message).

**Untouched:** all server-side tests, all Go TUI tests, all semantic suites, all parity tests, all other config-schema tests.

Expected suite delta: 2085 (current) − ~80 (9 orphan module tests at ~5–10 cases each + replDeprecation ~7 + surfaceResolver ~13 + buildReadlineAsker block ~5 + schema case ~1) + ~3 (updated launcher hard-error cases) ≈ **~2010 passing**. Exact count locked during T11 verification.

## 8. Comments referencing terminalRepl.ts

17 src files contain `terminalRepl` references — mostly comments of the form "mirrors terminalRepl.ts:402-405" pointing at the historical source of a pattern. These will dangle after M13.

Strategy: T8 (docs sweep) does a one-pass `grep -rn 'terminalRepl' src/ tests/` and replaces each comment either by (a) inlining the relevant context, or (b) deleting the now-unhelpful pointer. Not a per-file rewrite — purely "if the comment becomes a lie, fix or delete it." Estimated ~30 minutes.

50 doc-file references (state snapshots, ADRs, plans, postmortems) stay — they're historical record.

## 9. Smoke plan

Three boot-decision scenarios + one dispatcher round-trip:

1. **Default `sov` boots TUI.** Confirm `sov-tui` actually launches (smoke captures the TUI's splash output).
2. **sov-tui missing → hard error.** Move/rename the binary, run `sov`, assert exit 1 + stderr contains "sov-tui binary not found" + install command.
3. **Unknown CLI flag → Commander error.** Run `sov --ui repl`, assert non-zero exit + stderr complains about unknown option (Commander handles this, not M13 code).
4. **`sov dispatch` still works.** One 2-prompt round-trip via `sov dispatch` to verify no boot-path collateral damage. ~$0.05.

Save outputs to `docs/07-history/state/YYYY-MM-DD-m13-smoke/` with a README summarizing.

## 10. Postmortem-rule compliance

| Rule | Status |
|---|---|
| **Rule 1 — deprecation soak** | Waived. The rule protects downstream users; no users → no soak needed. See §3. |
| **Rule 2 — no helper deletion without consumer audit** | Satisfied. Each deleted helper has its full importer list verified in §4.2 / §4.4. |
| **Rule 3 — independent re-audit before claiming done** | Plan-side commitment. M13 close-out includes a 4-Opus parallel audit checking that no surviving caller references a deleted symbol, no surviving test imports a deleted module, no doc claim contradicts the new boot flow. |
| **Rule 4 — escape hatch preserved during transition** | N/A. The rule applies to in-flight migrations with active users. No users, no flight. Hard error on missing binary is the simplest behavior. |

## 11. Effort breakdown

| T | Task | Type | Est. |
|---|---|---|---|
| T1 | Rewire main.ts boot flow (collapse to ~13 lines per §6) | Opus | 25 min |
| T2 | Delete `src/ui/terminalRepl.ts` | mechanical | 5 min |
| T3 | Delete `src/cli/replDeprecation.ts` + its test | mechanical | 5 min |
| T4 | Delete `src/cli/surfaceResolver.ts` + its test | mechanical | 5 min |
| T5 | Trim `src/permissions/prompt.ts` + its test | Opus | 15 min |
| T6 | Delete 9 orphan `src/ui/*.ts` modules + tests (§4.2) | mechanical | 10 min |
| T7 | Remove `ui.surface` from `src/config/schema.ts` + update test | Opus | 10 min |
| T8 | Update `src/cli/tuiLauncher.ts` REPL-fallback hint string | mechanical | 5 min |
| T9 | Docs sweep — CLAUDE.md, README, usage.md, comment refs | Opus | 30 min |
| T10 | Parity audit — 4 parallel Opus subagents | Opus×4 | 45 min |
| T11 | Smoke — 4 scenarios per §9 | scripted | 15 min |
| T12 | State snapshot + ADRs in DECISIONS.md + close-out commit | Opus | 30 min |

**Total wall-time:** ~3.5 hours of dispatches, executable in one focused session.

## 12. Risks

- **R1 — Hidden REPL dependencies in shared modules.** §4.3 lists "shared keeps" but each might have terminalRepl-coupled code paths inside that become dead with the REPL. Pre-flight `bun run typecheck` after T2 surfaces any. The parity audit (T10) catches anything typecheck misses.
- **R2 — Smoke needs sov-tui binary in known states.** D1's hard-error case needs the binary actually missing. Smoke script toggles via temporary PATH manipulation or a moved binary; T11 owns the toggle logic.
- **R3 — `sov chat` deprecated subcommand still in main.ts.** `src/main.ts:200-206` is a separate deprecation thread (introduced pre-M11). Out of scope for M13, but a follow-up cleanup pass should retire it too.
- **R4 — `Settings.ui` orphan fields after M13.** `userSettings.ui.{theme, footer, diffRender, contextMeter, toolOutput}` are only read by terminalRepl. After M13 they become dead config surface — schema accepts them but nothing consumes them. M13 does NOT clean these up (would expand scope and risk breaking schema tests); a follow-up cleanup pass should retire the orphan fields after M13 ships.

## 13. What lands after M13

Open backlog: **#17** only (P4, conditional eval-gated auto-promote).

Next milestone after M13 — TBD. Phase 16.1 effectively ends with M13. Possible directions:
- Backlog #17 (P4, low-priority).
- Polish pass on TUI ergonomics surfaced during soak.
- New phase scope per the docs repo's harness-build-plan.

The state snapshot will close out Phase 16.1 formally.
