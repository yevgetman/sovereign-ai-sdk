# Config UX rebuild — implementation plan

**Spec:** [`specs/2026-05-24-config-ux-rebuild-design.md`](specs/2026-05-24-config-ux-rebuild-design.md)
**Target release:** v0.5.1
**Authorization:** autonomous (user 2026-05-24)

## Task list

### T1 — Wire schema extensions (sequential foundation)
Add to `src/server/schema.ts`:
- `PickerOpenItemSchema` gains optional `valueColumn` (string) + `badge` (`'live' | 'reload'`).
- New `InputOpenConfigSchema` with `title` / `subtitle?` / `initial?` / `placeholder?` / `masked?` / `onSubmit: { command }`.
- `CommandResponseSchema.sideEffects` gains `inputOpen?: InputOpenConfigSchema` + `verboseChanged?: boolean`.

Mirror Go side: `transport/types.go` gets `InputOpenPayload` struct; `transport/picker_events.go` (or equivalent) extended.

Tests added inline as part of this commit:
- `tests/server/schemaPickerExt.test.ts` — round-trip backwards-compat (existing pickerOpen still parses) + new fields parse.
- `transport/input_events_test.go` — decoder for InputOpenPayload.

### T2 — Catalog types + skeleton (sequential, depends on T1)
- Create `src/config/catalog.ts` with the types (`ConfigEditor`, `LiveApplyHook`, `LiveApplyContext`, `ConfigItem`, `ConfigGroup`) and stub `CONFIG_CATALOG: readonly ConfigGroup[] = []` + `findGroup` / `findItem` helpers.
- Create `src/config/liveApply.ts` with `LiveApplyContext` + the six v0 hook fns as no-ops returning `'persisted-only'` (stub for T3 to fill in).

Test stub:
- `tests/config/catalog.test.ts` — `findGroup('general')` returns undefined (catalog empty in T2; populated in T3).

### T3 — Populate catalog + implement live-apply hooks (depends on T2)

Best dispatched to a single subagent that owns both — they're tightly coupled.

- Populate all 10 groups + every field per the spec's catalog-coverage table.
- Implement the six v0 live-apply hooks:
  - `theme` → calls `setTheme(value)` + sets `themeChanged` side-effect via a new optional `LiveApplyContext.recordSideEffect` accessor.
  - `defaultModel` → `ctx.commandCtx?.setModel(...)`.
  - `providers.<x>.model` → conditional on active provider.
  - `maxTurns` → confirm applied (read-on-demand verified).
  - `verbose` → set `verboseChanged` side-effect.
  - `webSearch.*` → confirm applied (read-on-demand verified).
- Verification dispatched as part of this task: grep WebSearchTool + the turn loop + verbose renderers to confirm read-on-demand assumptions. If any are NOT read-on-demand, downgrade hook to `persisted-only` and note in the catalog item's description.

Tests:
- `tests/config/catalog.test.ts` — every group + item shape; every dotpath resolves; live-apply paths exist where declared.
- `tests/config/liveApply.test.ts` — each hook tested for both in-session and `sov config` standalone paths.

### T4 — configOps slash dispatcher (depends on T3)
Extract the old `handleConfigCommand` from `src/commands/registry.ts` into `src/commands/configOps.ts`. Rewrite to:
- No args → emit `pickerOpen` for root menu (all groups + Advanced if any unmanaged keys).
- `<group-id>` → emit `pickerOpen` for that group's items, with `valueColumn` (current value) + `badge` per item.
- `edit <dotpath>` → emit `pickerOpen` (boolean/enum) OR `inputOpen` (string/number/secret).
- `set <dotpath> <value>` → validate via schema, persist, fire live-apply hook, emit `pickerOpen` for the parent group with updated values, return toast text.
- `unset <dotpath>` → same as set but with undefined.
- Preserve legacy `show` / `path` / `get` verbs unchanged (text output, no pickerOpen).

Tests:
- `tests/commands/configOps.test.ts` — full coverage of all verbs.

### T5 — Extended PickerCard + new InputCard (Go) — PARALLEL TO T3/T4

Best dispatched to a Go-focused subagent.

- `packages/tui/internal/components/pickercard.go` — add `ValueColumn` + `Badge` fields to the `PickerItem` mirror struct (`transport/types.go`); extend `View()` to render right-aligned value column + colored badge after each item. Backwards-compat: when neither is set, layout matches today.
- `packages/tui/internal/components/inputcard.go` — new component using `bubbles/textinput`. Constructor, `View(width int)`, `Update(msg)`, `Value()`, `Command()`, `Masked()`, `SetTheme(t)` methods.
- `packages/tui/internal/transport/types.go` — `InputOpenPayload` struct + decoder.

Tests:
- `pickercard_test.go` — extend with value-column + badge + secret-mask rendering tests.
- `inputcard_test.go` — new file: title, subtitle, masked vs normal, value-on-submit.

### T6 — sov config --config-only mode (TS) — PARALLEL TO T3/T4/T5

- `src/cli/configMode.ts` — `runConfigOnlyMode(opts)` boots minimal Hono server: session creation, slash dispatcher, command metadata, SSE bus. NO runtime construction (no `buildRuntime`, no preflight, no providers, no bundle).
- TUI launcher CLI gains `--initial-command=<text>` flag.
- `src/main.ts` — `sov config` action calls `runConfigOnlyMode()` instead of `runConfigMenu`.

Tests:
- `tests/server/configMode.test.ts` — minimal server boots; dispatcher route responds to `/config`; no runtime constructed.

### T7 — Go TUI app.go integration (depends on T5)
- New SSE switch cases: `inputOpen` (construct InputCard, set modal), `verboseChanged` (update model verbose state, recompute toolcard render mode).
- Key dispatch: when InputCard is the active modal, Enter dispatches command + value, Esc cancels.

Tests:
- `app_test.go` — new cases for inputOpen + verboseChanged side-effects.

### T8 — Delete legacy raw-mode configMenu (depends on T6)
- Delete `src/ui/configMenu.ts` (390 LoC).
- Update `tests/ui/configMenu.test.ts` (or equivalent) to point at the catalog instead.
- Confirm no other imports.

### T9 — Semantic suite + smoke (depends on T7 + T8)
- Add `tests/semantic/suites/23-config-ux.cases.ts` with the 5 cases listed in the spec.
- Add a smoke test in `tests/cli/configMode.smoke.ts` (or similar) for `sov config` boot/exit.

Run:
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `cd packages/tui && go test ./...`
- `bun run test:semantic` — optional, may not all pass on first try; document any flakes in testing-log.

### T10 — Final review (depends on T9)
Dispatch a final-review subagent (Opus) to read the full diff vs `master` and surface any HIGH/CRITICAL issues. Fix inline.

### T11 — Commit + push + sov upgrade + release (depends on T10)
- Atomic commits per logical task batch (T1, T2+T3, T4, T5, T6, T7, T8, T9 ≈ 7-8 commits).
- Push to `origin/master`.
- Run `sov upgrade` locally.
- Bump version 0.5.0 → 0.5.1.
- Run `bun run release v0.5.1` (per `docs/05-conventions/cutting-releases.md`).

### T12 — Close-out (depends on T11)
- Write `docs/07-history/state/2026-05-24-config-ux-rebuild.md` close-out snapshot.
- Append entry to `docs/06-testing/testing-log.md`.
- Update `CLAUDE.md` index pointer to the new state file.
- Mirror to `AGENTS.md` (byte-identical with `CLAUDE.md`).

## Parallelization

```
T1 ─┬─► T2 ─► T3 ─► T4 ─┐
    │                    │
    │            ┌───────┘
    └───► T5 ────┴─► T7 ─┐
    │                    │
    └───► T6 ─► T8 ──────┤
                         │
                         ▼
                         T9 ─► T10 ─► T11 ─► T12
```

T3, T5, T6 are parallel after T2 lands. T4 depends on T3. T7 depends on T5. T8 depends on T6. T9 waits for both T7 and T8.

## Per-commit gate (every commit)
Per `docs/05-conventions/lint-and-commit.md`: `bun run lint && bun run typecheck && bun run test`. Skip semantic and Go-side suites per-commit; run them at T9.
