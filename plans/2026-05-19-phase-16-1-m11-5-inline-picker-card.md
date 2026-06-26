# Phase 16.1 M11.5 — Inline picker card implementation plan

**Spec:** [`specs/2026-05-19-phase-16-1-m11-5-inline-picker-card-design.md`](specs/2026-05-19-phase-16-1-m11-5-inline-picker-card-design.md)
**Mode:** Pending user authorization (autonomous-execution mode requested).
**Predecessor HEAD:** `4f971ea` (testing-log entry for the staticEntries discoverability fix).

## Tasks (ordered)

### T1 — Type definitions: `PickerOpenConfig` + `CommandContext.requestPicker`

**Files:**
- `src/commands/types.ts` (modified) — add `PickerOpenConfig` interface and the optional `requestPicker` method on `CommandContext`. Add to the dispatcher's side-effects shape: `pickerOpen?: PickerOpenConfig`.

**Spec ref:** §4.1.

**Tests:** Type-only change. No new test file; existing `tests/commands/dispatch.test.ts` and friends still type-check.

**Commit:** `feat(commands): add PickerOpenConfig type + CommandContext.requestPicker capability`

### T2 — Server: `buildServerCommandContext` populates `requestPicker`

**File:** `src/server/commandContext.ts` (modified).

**Change:** Inside `buildServerCommandContext`, populate `requestPicker` as a closure over the local `sideEffects` Map. Throws on double-emission within a single dispatch (one picker per command call).

**Tests:** `tests/server/commandContext.test.ts` (new or extended):
- Calling `ctx.requestPicker(config)` records the payload in `__sideEffects`.
- Calling `ctx.requestPicker` twice throws.
- A context built without server-mode helpers (e.g., the CLI / REPL path) has `ctx.requestPicker === undefined`.

**Spec ref:** §4.1, ADR M11.5-01.

**Commit:** `feat(server): wire requestPicker capability through ServerCommandContext`

### T3 — Migrate `runModelPicker` with the `requestPicker` branch

**File:** `src/commands/pickers.ts` (modified — `runModelPicker`).

**Change:** Before the `if (!process.stdin.isTTY)` check, add the new `if (ctx.requestPicker) { ... return ''; }` branch per spec §4.1. Existing TTY-pick path stays as the fallback.

**Tests:** `tests/commands/pickers.requestPicker.test.ts` (new):
- With `ctx.requestPicker` defined, `/model` (no args) emits `pickerOpen` with the expected `{ title, subtitle, items, initial, onSelect }` shape.
- With `ctx.requestPicker` defined and explicit args (`/model claude-sonnet-4-6`), no picker is emitted; existing setModel + return-text behavior preserved.
- With `ctx.requestPicker` undefined and no TTY, the existing "model picker requires a TTY" error message returns (REPL legacy path unchanged).

**Spec ref:** §4.1, §5.

**Commit:** `feat(commands): /model emits pickerOpen side-effect in server mode`

### T4 — Go TUI: `PickerCard` component

**Files:**
- `packages/tui/internal/transport/picker.go` (new) — `PickerItem` + `PickerOpenPayload` types matching the server envelope.
- `packages/tui/internal/components/pickercard.go` (new, ~180 LoC) — Bubble Tea component per spec §4.2.
- `packages/tui/internal/components/pickercard_test.go` (new) — render snapshots; ↑↓ clamps; `Selected()` correctness; theme switching; popup height calculation.

**Visual contract:** Match `~/Desktop/goodux.png` — title bold, subtitle dim, items list with `›` selection marker, footer with shortcut hint. Use `theme.CardBorderStyle()` for the box (consistent with `SlashAutocomplete`).

**Spec ref:** §4.2.

**Commit:** `feat(tui): PickerCard component for inline picker rendering`

### T5 — Wire `pickerOpen` → `PickerCard` in `app/app.go`

**Files:**
- `packages/tui/internal/app/app.go` (modified) — add `picker *components.PickerCard` field to app state; on dispatcher response with `sideEffects.pickerOpen`, instantiate `PickerCard` and store; lock input.
- `packages/tui/internal/transport/dispatch.go` (or wherever dispatcher response parsing lives) — extend response struct to include `pickerOpen` in `SideEffects`.
- `packages/tui/internal/app/picker_dispatch_test.go` (new) — tests:
  - Response with `pickerOpen` → `app.picker` non-nil, input locked.
  - Response without `pickerOpen` → `app.picker` stays nil.

**Spec ref:** §4.2, §3 architecture diagram.

**Commit:** `feat(tui): handle pickerOpen side-effect and lock input while picker open`

### T6 — Wire Enter (dispatch selection) and Esc (cancel)

**Files:**
- `packages/tui/internal/app/app.go` (modified) — input handler branches: when `app.picker != nil`, route ↑↓/Enter/Esc to picker; ignore all other keys.
- On Enter: read `picker.Selected()` and `picker.Command()`, dispatch via existing dispatcher transport with `/<command> <value>`, clear `app.picker`, unlock input.
- On Esc: clear `app.picker`, unlock input; optionally append a dim "cancelled." line for affordance.
- `packages/tui/internal/app/picker_keys_test.go` (new) — tests:
  - Enter dispatches with expected command+args; picker cleared.
  - Esc clears picker; no dispatch occurs.
  - Other keys (a-z, etc.) are ignored.

**Spec ref:** §3 architecture, §4.2.

**Commit:** `feat(tui): picker card key handling — Enter dispatches selection, Esc cancels`

### T7 — Migrate `runResumePicker` and `runExport`

**Files:**
- `src/commands/pickers.ts` (modified — `runResumePicker`).
- `src/commands/sessionOps.ts` (modified — `runExport`).
- Tests extending `tests/commands/pickers.requestPicker.test.ts` and `tests/commands/sessionOps.requestPicker.test.ts` (new).

**Same shape as T3:** `requestPicker` branch before the TTY check. `/resume` and `/export` both have a clear "items + initial + onSelect" form mapping naturally.

For `/export`, `onSelect.command` is `"export"`; selecting `"md"` dispatches `/export md` which already works (existing arg-handling preserved).

For `/resume`, `onSelect.command` is `"resume"`; selecting a session UUID dispatches `/resume <uuid>`. Note: the existing `/resume <uuid>` form returns the resume command for the user to run — it doesn't yet load in-process (Wave-4 work per `pickers.ts:8-11`). So picker selection prints the resume command, matching today's REPL behavior. No regression.

**Spec ref:** §5 coverage matrix.

**Commit:** `feat(commands): /resume and /export emit pickerOpen side-effect in server mode`

### T8 — Spacing fix: blank line above `…running /<command>` indicator

**Files:**
- The TUI view path that renders the running-command indicator. Locate via `grep -r "running /" packages/tui/` (likely a status line in `app/app.go` or a dedicated component).

**Change:** Add a blank-line spacer above the indicator so it sits clear of the input prompt. Reference: `~/Desktop/ux2.png`.

**Tests:** Visual; covered by integration smoke. If a unit test asserts the indicator layout exists, extend it; otherwise no new test file.

**Commit:** `fix(tui): blank-line spacer above running-command indicator`

### T9 — Real-Anthropic E2E smoke (env-gated)

**File:** `tests/parity/m11_5PickerSmoke.test.ts` (new, env-gated by `SOV_M11_5_REAL_SMOKE=1`).

**Scenario:** Start a session, dispatch `/model` (no args), assert response envelope has `output: ''` + `sideEffects.pickerOpen` with 3 anthropic models. Then dispatch `/model claude-sonnet-4-6`, assert response has the success text + `sideEffects.modelChanged`. ~$0.005 (one cheap setup + two dispatcher calls).

Smoke output captured at `docs/07-history/state/2026-05-19-m11-5-smoke/` (transcript + README).

**Spec ref:** §5 end-to-end.

**Commit:** `test(parity): M11.5 real-Anthropic picker smoke (env-gated)`

### T10 — Close-out

**Files:**
- `docs/07-history/state/2026-05-19-m11-5.md` (new) — close-out snapshot mirroring the M11 format: scope, suite delta, commit chain, audit, smoke, ADRs, backlog status.
- `CLAUDE.md` — bump session-boot reference to the new close-out snapshot. **Verify `AGENTS.md` byte-identical via `diff` before commit.**
- `docs/08-roadmap/backlog/post-phase-13-4.md` — update "Last sync" line; close any items M11.5 resolves (none expected; this is a new feature, not a backlog burn-down).
- `docs/06-testing/testing-log.md` — append entry summarizing gate result, commit chain, smoke status.
- ADRs M11.5-01, -02, -03 land inline in the spec (already drafted).

**Final steps:**
- `bun run lint && bun run typecheck && bun run test` — all three green.
- `bun run tui:build` — Go TUI compiles.
- `git push origin master` — autonomous.
- `sov upgrade` — refresh global binary.

**Commit:** `docs(state): 2026-05-19 — Phase 16.1 M11.5 close-out (inline picker card)`

## Estimation

- T1, T2, T3 (server-side): ~2 dispatches each → ~1 session.
- T4 (PickerCard component): ~2-3 dispatches → ~0.5 session.
- T5, T6 (Go app.go wiring): ~3 dispatches → ~0.5 session.
- T7 (resume + export migration): ~2 dispatches → ~0.5 session.
- T8 (spacing fix): ~1 dispatch → ~15 min.
- T9 (smoke): ~1 dispatch → ~15 min.
- T10 (close-out): ~1 session.

**Total:** ~3 focused sessions, achievable in one wall-day with parallel subagent dispatches per the autonomous-execution mode established in M10.5 / M11.

## Verification checkpoints

After each commit:
- `bun run lint && bun run typecheck && bun run test` green.
- For Go-touching commits: `bun run tui:build` succeeds.

Before close-out:
- Manual TUI test: launch `sov`, type `/model`, navigate, select. Confirm inline card matches `~/Desktop/goodux.png`. Then type `/model claude-sonnet-4-6`, confirm direct-arg path still works.
- `/resume` and `/export` similarly.

## Risks + open questions

Risks tracked in spec §9. No open questions at plan-time — every decision is recorded in spec §6 (ADRs).
