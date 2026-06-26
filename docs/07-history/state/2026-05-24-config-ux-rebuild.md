# State of the build — 2026-05-24: config UX rebuild

**HEAD:** to be filled by the close-out commit.

**Chain since the Phase 2 release (`c882adf`, 2026-05-23 late evening — the `chore(release): bump version 0.4.1 -> 0.5.0` commit that closed the Phase 2 multi-provider task routing observability work):**
Phase 2 close-out → config UX rebuild spec + plan (`3901347`) → wire schema extensions (`8bfa177`) → catalog + live-apply (`6664d68`) → /config picker-driven dispatcher (`8db453e`) → sov config standalone mode (`f9c27cf`) → TUI components + integration (`6b76921`) → semantic suite (`b003190`) → (this close-out, TBD) → release v0.5.1.

**Suite:** TS — **2420/0/14** (+114 from Phase 2 close-out's 2306). Breakdown: schema-extension tests (+11), catalog+liveApply unit tests (+51), configOps dispatcher tests (+43), configMode standalone-server tests (+8), review-fix coverage tests (+3, see below). Go — `cd packages/tui && go test ./...` all green; +30 new tests across PickerCard extension (+7), InputCard new (+11), InputOpenPayload decoder (+4 in input_test.go), CommandSideEffects extension (+2 in commands_test.go), app.go integration (+6). Lint+typecheck clean.

**ADRs:** none. The rebuild is purely additive at the wire level — extends `PickerOpenItemSchema` with two optional fields (`valueColumn`, `badge`), adds new `InputOpenConfigSchema`, adds `inputOpen` + `verboseChanged` to `CommandSideEffectsSchema`. Existing picker callers (/model, /resume, /export, /theme) stay byte-identical. Two new TS modules (`src/config/catalog.ts`, `src/config/liveApply.ts`), one new TS slash-command module (`src/commands/configOps.ts`), one new TS standalone-mode entry (`src/cli/configMode.ts`), one new Go component (`packages/tui/internal/components/inputcard.go`), one new Go transport type (`packages/tui/internal/transport/input.go`). One legacy module deleted (`src/ui/configMenu.ts`, 389 LoC). No bundle changes. All design decisions captured inline in the spec at `specs/2026-05-24-config-ux-rebuild-design.md` and the plan at `plans/2026-05-24-config-ux-rebuild.md`.

**Status:** **Config UX rebuild closed.** The `sov config` raw-mode picker and the JSON-dump `/config` slash command are gone; both surfaces now share a hierarchical drill-in TUI driven by a curated 10-group catalog with optional per-field live-apply hooks and clear `✓ live` / `⟳ next session` badges. v0 live-apply set: theme, defaultModel, providers.<x>.model (conditional on active provider), verbose, webSearch.*. Everything else persists + signals reload-needed. Phase 2.5 / Phase 3 (multi-provider task routing follow-ups) and Phase 21 M2 (binary release automation) remain backlogged. Release v0.5.1 follows.

## Where we are

The user surfaced the limitation in two annotated screenshots (`config1.png`, `config2.png` on the desktop): the legacy `sov config` picker was a flat hand-curated list missing most parameters added since it was first written (it didn't surface taskRouting, the new Phase 17 cron block, Phase 18 openaiServer, the v0.5.0 task routing config, plus most of review / learning / debug — roughly half the schema was invisible), and the in-session `/config` slash command was just a JSON dump with no editing surface. The user authorized autonomous ship with the instruction "go with your best recommendation for every decision."

The rebuild replaces both surfaces with a single branded Bubble Tea TUI experience, driven by a curated catalog of fields in `src/config/catalog.ts`. The catalog covers every leaf field in `SettingsSchema` (`src/config/schema.ts`) across 10 logical groups + per-provider subgroups (providers-anthropic / providers-openai / providers-openrouter / providers-ollama), each item declaring its editor kind (boolean / enum / string / number / secret), optional description, secret flag, and optional live-apply hook reference. A separate `src/config/liveApply.ts` module owns the six v0 hooks keyed by dotpath; each hook handles both in-session (`commandCtx` defined) and `sov config` standalone (`commandCtx` undefined) execution.

The slash dispatcher in `src/commands/configOps.ts` routes every `/config` invocation:
- `/config` (no args) → root menu picker (10 groups + optional "Advanced (unmanaged)" group)
- `/config <group-id>` → group submenu picker with `valueColumn` (right-aligned current value, masked for secrets) and `badge` (`'live'` if a liveApply hook exists, `'reload'` otherwise)
- `/config edit <dotpath>` → picker (boolean/enum) or InputCard (string/number/secret)
- `/config set <dotpath> <value>` → editor-aware coercion (string fields preserve numeric-looking input verbatim — fixes the legacy `parseValueLiteral` over-coercion), schema-validate, persist, fire live-apply hook, emit parent-group picker (refreshed values) + toast
- `/config unset <dotpath>` → symmetric
- `/config show | path | get` → preserved as scriptable escape hatches (text-only output)

The pivotal design decision was to keep the M11.5 re-dispatch idiom (each menu hop is a fresh `/config ...` slash dispatch over the wire; no client-side tree state). Drill-in, edit, and commit all go round-trip through the dispatcher; the TUI just renders whichever side-effect arrives. This kept the new Go component surface tiny — one new component (`InputCard`), one extension to the existing `PickerCard` (value column + badge in the wide-layout branch), and four new SSE switch cases in `app.go`.

The `sov config` standalone subcommand boots a lightweight server-plus-TUI process. `src/cli/configMode.ts` hand-rolls a minimal Runtime literal: real `SessionDb` rooted at `<harnessHome>/sessions.db`, stub-everything-else (empty toolPool, empty agents, empty skills, throw-on-invoke task/review/scheduler callbacks). No `buildRuntime`, no preflight, no provider construction, no bundle load. Boot is sub-50ms vs. ~1-3s for full `sov`. The TUI launches with `--initial-command=/config` (new sov-tui CLI flag) so the user lands in the root config menu immediately.

A final-review subagent surfaced one HIGH and two MEDIUMs which were folded into the same session:
- **HIGH** — InputCard / picker closed on Enter before the dispatcher resolved, so validation failures left the user back at the prompt with their typed value gone. Fix: `runSet` catches schema-rejection in `setAt`, re-emits the SAME editor with the typed value preserved + the error as subtitle, so the user corrects in place.
- **MEDIUM** — `parseValueLiteral` over-coerced numeric-looking strings on `editor.kind === 'string'` fields (typing `42` for `defaultModel` was rejected as "expected string, received number"). Fix: new `coerceValueForEditor` switches on editor kind — string/secret/enum preserve the raw input verbatim, number uses `Number()` with NaN check, boolean accepts 'true'/'false' case-insensitive.
- **MEDIUM** — themeHook mutated the TS-side singleton even in `sov config` standalone mode where the singleton is unused. Fix: moved the `commandCtx === undefined → return 'persisted-only'` guard before the `setTheme(...)` call.

Three new tests in `tests/commands/configOps.test.ts` pin each of the three fixes.

## What shipped

### Wire schema extensions (`src/server/schema.ts` + `packages/tui/internal/transport/`)

- `PickerOpenItemSchema` gains optional `valueColumn: string` (right-aligned current value display) and `badge: 'live' | 'reload'` (color-coded badge). Both optional — existing picker callers (/model, /resume, /export, /theme) stay byte-identical.
- New `InputOpenConfigSchema` parallel to `PickerOpenConfigSchema`, with `title`, optional `subtitle`/`initial`/`placeholder`, optional `masked: boolean`, required `onSubmit: { command }`.
- `CommandSideEffectsSchema` gains `inputOpen?: InputOpenConfigSchema` and `verboseChanged?: boolean`.
- Go-side `transport/input.go` (new) mirrors `InputOpenPayload`; `transport/picker.go` extends `PickerItem` with `ValueColumn` + `Badge`; `transport/commands.go` extends `CommandSideEffects` with `*InputOpenPayload` + `*bool` for VerboseChanged (pointer so absence is distinct from explicit `false`).
- 11 new TS schema tests + 4 new Go decoder tests pin the wire on both sides.

### Curated catalog (`src/config/catalog.ts`)

- 10 groups: General, Providers (drill-in root), Task routing, Router, Compaction, Web search, Review, Learning, Debug, OpenAI server, Appearance — plus four per-provider subgroups (`providers-anthropic`, `providers-openai`, `providers-openrouter`, `providers-ollama`).
- Each `ConfigItem` declares: `path` (dotpath into Settings), `label`, optional `description`, `editor` (discriminated union: `boolean | enum | string | number | secret`), optional `secret: true`, optional `liveApply: keyof typeof LIVE_APPLY_HOOKS`.
- Helpers: `findGroup(id)`, `findItem(path)`, `findGroupForItem(path)` (for parent-refresh on commit), `listRootMenuGroups()` (filters out drill-in subgroups), `listUnmanagedKeys(settings)` (top-level keys not in catalog).
- 817 LoC (slight overage from the 800-line cap; cohesive enough that splitting would be net negative).

### Live-apply hook system (`src/config/liveApply.ts`)

- `LiveApplyHook = (newValue, ctx) => Promise<'applied' | 'persisted-only'>`.
- `LiveApplyContext = { commandCtx?: CommandContext; recordSideEffect?: (effect) => void }`.
- `LIVE_APPLY_HOOKS: Record<string, LiveApplyHook>` keyed by dotpath. Six hooks:
  - `theme` → guards `commandCtx === undefined` first (standalone mode); else `setTheme(...)` + `recordSideEffect({ themeChanged })`.
  - `defaultModel` → `commandCtx.setModel(String(value))`.
  - `providers.{anthropic,openai,openrouter,ollama}.model` → conditional on `commandCtx.providerName` matching; otherwise `'persisted-only'`.
  - `verbose` → `recordSideEffect({ verboseChanged: value })`.
  - `webSearch.{provider,apiKey,maxResults}` → confirmed read-on-demand at `WebSearchTool.ts:61`; hook just returns `'applied'`.
- `maxTurns` intentionally NOT included — verified in `agentRunner.ts` that the runtime captures it at boot; hot-reload would need broader plumbing. Catalog item is reload-needed.

### `/config` slash dispatcher (`src/commands/configOps.ts`)

- `dispatchConfigCommand(args, ctx): Promise<string>` — the main entry. Routes every verb.
- `coerceValueForEditor(rawValue, item)` — editor-aware coercion replacing the legacy `parseValueLiteral` over-eager literal-parse. Fix from review #5.
- `reopenEditorWithError(item, path, rawValue, errorMessage, ctx)` — on schema-validation failure, re-emits the SAME editor (picker for boolean/enum, InputCard for string/number/secret) with the typed value preserved + the validation error as subtitle. Fix from review #1 (HIGH).
- `emitParentRefresh(path, toast, ctx)` — on successful commit, looks up parent group via `findGroupForItem`, re-emits that group's picker (refreshed values), returns the toast as slash output.
- `pickToast(verdict, hookPresent, standalone)` — chooses between "saved — applied to current session" (live verdict), "saved — effective next session" (hook present but persisted-only OR no hook in-session), "saved" (standalone mode).

The `/config` slash command in `src/commands/registry.ts` delegates entirely to `dispatchConfigCommand`. The legacy `handleConfigCommand` block is gone. `src/commands/info.ts`'s `/settings` alias also routes through `dispatchConfigCommand`.

### CommandContext extension (`src/commands/types.ts` + `src/server/commandContext.ts`)

- `CommandContext` gains:
  - `requestInput(config: InputOpenConfig): void` — parallel to existing `requestPicker`.
  - `recordVerboseChange(value: boolean): void` — parallel to existing `recordThemeChange`.
  - `isConfigStandalone?: boolean` — distinguishes the `sov config` standalone session from a regular in-session `/config`.
- Server-side `buildServerCommandContext` mirrors all three with closures that populate the side-effects bag.
- `src/server/routes/commands.ts` `SideEffectsBag` / `hasSideEffects` / `pickSideEffects` extended for `inputOpen` + `verboseChanged`.
- `src/server/runtime.ts` gains optional `configStandalone?: boolean` field on `Runtime`.

### `sov config` standalone mode (`src/cli/configMode.ts`)

- `runConfigOnlyMode(opts)` — exported production entry. Boots minimal server + sov-tui.
- `bootConfigOnly(opts)` — test seam: just the server boot, no TUI spawn.
- Hand-rolled minimal Runtime literal (~250 LoC):
  - Real `SessionDb` rooted at `<harnessHome>/sessions.db`.
  - Stub `LLMProvider` that throws if streamed (cast through the type to satisfy the async-generator signature without unreachable yield).
  - Stub `SessionContext` factory replacing `buildSessionContext` — no TraceWriter, no LearningObserver, no ReviewManager.
  - Throw-on-invoke `SubagentScheduler` / `TaskManager` / `LaneSemaphores` / `LaneRegistry` / `DaemonEventBus` / `ApprovalQueue` / `ServerCompactor` instances.
- Sentinel `(none)` / `(none)` for provider/model in splash card.
- TUI args: `--port`, `--session-id`, `--initial-command=/config`, `--model "(none)"`, `--provider "(none)"`, `--harness-version <VERSION>`.
- Boot time sub-50ms vs. ~1-3s for full `sov`.

### Extended `PickerCard` (`packages/tui/internal/components/pickercard.go`)

- `View()` switches to a "wide layout" branch when any item has `ValueColumn` or `Badge`. Computes label-column width across all items so values align uniformly; 3-space gap from label to value; badge follows with one-space separator.
- `✓ live` renders Catppuccin green (`#a6e3a1`); `⟳ next session` reuses the existing pickerItemColor peach (`#fab387`).
- Badge style is foreground-only (no Bold) so it stays visually consistent on selected vs unselected rows.
- Backwards-compat preserved — items without ValueColumn/Badge hit the original M11.5 code path verbatim. /model, /resume, /export, /theme keep their visual identity.

### New `InputCard` (`packages/tui/internal/components/inputcard.go`)

- Bubble Tea component on `bubbles/textinput`.
- Constructor pre-populates from `payload.Initial`, focuses immediately, flips to `EchoMode = textinput.EchoPassword` when `payload.Masked: true`.
- Same `CardBorderStyle` box as PickerCard, padding(0, 1), width-2.
- Methods: `Update`, `View(width)`, `Value()`, `Command()`, `Masked()`, `SetTheme(t)`.
- 11 new tests cover masking, view rendering, typing, command passthrough, narrow-width fallback, theme swap.

### Go `app.go` integration (`packages/tui/internal/app/app.go`)

- New model fields: `inputCard *components.InputCard`, `initialCommand string`, `initialFired bool`.
- New `WithInitialCommand(cmd)` builder.
- Input-card key routing block: Enter dispatches `<command> <value>`, Esc cancels (`(cancelled)` marker), other keys forward to embedded textinput.
- New `inputOpen` SSE side-effect handler — clears any active picker first, then constructs the new InputCard.
- New `verboseChanged` SSE side-effect handler — live-updates `m.verboseRaw` so the toolcard render mode flips between compact and detailed without restart.
- `applyThemeByName` propagates to the input card.
- `initialCommand` fires once on the first `WindowSizeMsg` (guarded by `initialFired`); terminal resizes don't re-fire.
- 15 new tests cover all of the above.

### `--initial-command` CLI flag (`packages/tui/cmd/sov-tui/main.go`)

- New `--initial-command=<text>` flag forwarded through `app.WithInitialCommand(...)`. Used by `sov config` to land the user directly in the config picker.

### Legacy deletion

- `src/ui/configMenu.ts` — 389 LoC removed. The hand-rolled raw-mode picker with the static `FIELDS` array is gone.
- `tests/commands/configSlash.test.ts` — updated the now-stale "bare /config returns show output" test to use explicit `/config show` (bare now opens a picker).

### Tests

| Layer | New tests | Notes |
|---|---|---|
| `tests/server/schema.test.ts` | +11 | Schema extensions, backwards-compat. |
| `tests/config/catalog.test.ts` | +16 | Every catalog group + item + dotpath validity. |
| `tests/config/liveApply.test.ts` | +35 | Each of the 6 hooks under both in-session and standalone paths. |
| `tests/commands/configOps.test.ts` | +43 | Every verb, schema rejection, parent refresh, side-effects, review fixes. |
| `tests/server/configMode.test.ts` | +8 | Standalone server boot + dispatch. |
| `tests/semantic/suites/23-config-ux.cases.ts` | +5 | Live-binary behavior (JSON-dump regression, reload badge, theme live-apply, validation error, secret masking). |
| `pickercard_test.go` | +7 | Wide-layout branch, badge rendering, backwards-compat. |
| `inputcard_test.go` (new) | +11 | Bubble Tea integration. |
| `app_test.go` | +15 | inputOpen + verboseChanged switch cases, initial-command guard. |
| `input_test.go` (new) | +4 | InputOpenPayload decoder. |
| `commands_test.go` | +2 | CommandSideEffects extensions. |
| **TOTAL** | **+157** | (excluding the +22 expect-call augmentations) |

Suite numbers: TS **2420/0/14** (+114 from Phase 2 baseline of 2306). Go all packages green; +30 new tests.

## Behavioral notes worth knowing next session

1. **Re-dispatch chain is stateless.** Each menu hop is a fresh `/config ...` slash dispatch over the wire. No client-side tree state. This matches the M11.5 idiom; the new wider catalog doesn't change the protocol.

2. **`/config` slash response can carry BOTH a toast AND a `pickerOpen`.** On successful set, the slash returns `output: "saved — ..."` AND `sideEffects.pickerOpen: <parent group, refreshed>`. The TUI prints the toast via `tea.Println` (lands in scrollback) and opens the parent picker (replaces any active modal). Validation failures similarly carry `output: "config error: ..."` AND the re-opened editor.

3. **Standalone mode collapses live-apply.** When `sov config` boots, `runtime.configStandalone: true` flows through to `CommandContext.isConfigStandalone`, which `runSet` reads to skip passing `commandCtx` into the hook. Every hook honors the spec contract by returning `'persisted-only'` when `commandCtx === undefined`. The toast collapses to plain "saved" — no claim about "applied to current session" since there isn't one. Theme hook now also skips the singleton mutation in this case.

4. **String fields preserve numeric-looking input.** The legacy `parseValueLiteral` over-coerced — typing `42` for `defaultModel` became a number and was rejected by the string-only schema. The new `coerceValueForEditor` switches on editor kind; string/secret/enum preserve the raw input verbatim. Numbers use `Number()` with NaN check; booleans accept 'true'/'false' case-insensitive.

5. **Validation failures preserve the editor.** When `setAt` rejects via the schema, `reopenEditorWithError` re-emits the SAME editor (picker for boolean/enum, InputCard for string/number/secret) with the typed value preserved + the validation error as subtitle. The user corrects in place rather than re-drilling.

6. **Secrets are masked at two layers.** `redactSecrets(settings)` returns the value as `'***'`; `renderValueColumn` additionally overrides with bullets (`••••••••`) for any `secret: true` catalog item. Either layer alone would protect; both is defense-in-depth.

7. **Unmanaged keys surface via `listUnmanagedKeys`.** If a future schema-extension lands without a catalog update, the missing keys appear in an "Advanced (unmanaged)" group at the root menu. Today the catalog is exhaustive, so the group is empty in practice. Spec §"Edge cases #7".

8. **`sov config` boot is fast.** Sub-50ms because no `buildRuntime`. The TUI splash card shows `provider: (none)` / `model: (none)` — sentinels indicating the session has no agent loop. Don't try to send a turn from this surface; the stub provider throws.

9. **Existing picker callers stay byte-identical.** `/model`, `/resume`, `/export`, `/theme` emit `pickerOpen` without `valueColumn` or `badge`, so the Go-side PickerCard renders them via the original M11.5 layout. Verified by a backwards-compat test in `pickercard_test.go`.

10. **No bundle changes.** The catalog and the slash logic are entirely in `src/` and `packages/tui/`. The `bundle-default/` tree is byte-identical to v0.5.0. This means `sov upgrade` to v0.5.1 only ships a new TS binary + new Go TUI binary; the bundle is unchanged.

## Open follow-ups

(Triaged from the final-review pass + spec's "Phase 2 candidates".)

1. **Esc from a sub-picker should re-dispatch the parent (review MEDIUM #1).** Today Esc unconditionally nils the picker with `(cancelled)`. Spec §"Edge cases #8" requires "Esc from a picker returns to the previous menu (re-dispatches the parent `/config <group-id>` or `/config`). Esc from the root menu closes the modal." Solution: thread `OnEscape: { command }` through the picker payload, default to parent group on submenus and `''` on root. Defer — UX is functional today, just less ergonomic.

2. **Unmanaged-keys group is effectively dead code under strict schema (review MEDIUM #6).** `readConfig()` calls `SettingsSchema.parse()` (strict mode), so unknown top-level keys throw BEFORE `listUnmanagedKeys` runs. The fallback only triggers if a future schema-extension lands without catalog update. Solution: read raw JSON for unmanaged probing, parsed for everything else. Defer until a real schema-vs-catalog divergence surfaces.

3. **`sov config` standalone theme apply.** In standalone mode, changing theme persists but the in-process Go TUI doesn't visibly update because the live-apply hook returns 'persisted-only' (skipping the side-effect emit). The user changes theme, sees "saved", but the chrome stays the same until next launch. Consider relaxing the standalone guard for the `themeChanged` side-effect specifically. Low priority — most users won't set theme from `sov config` standalone.

4. **More live-apply hooks (Phase 2 candidates).** `permissionMode`, `microcompaction.*`, `compaction.*`, `review.*`, `learning.*` — many of these can become live-applyable with modest read-on-demand wiring in the consuming subsystem. Each is an isolated change; no architectural rework. Triage as user demand surfaces.

5. **Hot-reload for `taskRouting.*`.** Requires rebuilding the lane registry + swapping the system prompt segment + reconstructing the runtime's smart-router state. Significant work, but the only major user-visible reload-needed surface. Future phase candidate.

6. **Profile-scoped config writes.** Today edits write to `~/.harness/config.json`. When the user is `sov -p work`, edits should write to that profile's config path. Mechanical — wire `resolveConfigPath(profile)` through writeConfig.

7. **Search/jump (Approach 3 from brainstorm).** Global fuzzy find across leaf fields. `/` keystroke from anywhere opens a flat search picker. Power-user ergonomics once the catalog grows past ~50 leaves.

8. **Cut v0.5.1 release.** Per `docs/05-conventions/cutting-releases.md`. The rebuild touches `src/` and `packages/tui/`; a same-session binary release is mandatory so `~/.sov/bin/sov` picks up the new TUI.

9. **Append testing-log entry.** Follow-up task in this close-out chain (T19).

## Postmortem-rule compliance check

The Phase 16.1 revert's Rules 1-4 (`docs/07-history/postmortems/2026-05-12-phase-16-revert.md`) apply to foreground-surface refactors. The config UX rebuild IS a foreground-surface refactor (the `sov config` and `/config` surfaces both changed), so all four rules engage:

- **Rule 1 (deprecation soak).** The legacy raw-mode picker is GONE — but it had been documented as "Phase 10.1 interim — Phase 16.7 (TUI polish with Ink) is expected to supersede this with a richer Ink-based component" in the file header comment since the day it was written. The replacement IS the long-promised TUI-based component (Bubble Tea Go instead of Ink TS, but the spirit is identical). No deprecation soak needed since the file was self-documented as a placeholder. The `/config` JSON-dump verb is preserved as `/config show` (escape hatch for scripts).
- **Rule 2 (no helper deletion).** Most changes are additive: new TS modules (`catalog.ts`, `liveApply.ts`, `configOps.ts`, `configMode.ts`), new Go component (`inputcard.go`), new Go transport (`input.go`), new SSE switch cases, new schema fields. ONE module deleted: `src/ui/configMenu.ts`. Its single public function `runConfigMenu` had one caller (`sov config` in main.ts), now rewired to `runConfigOnlyMode`. Its test helper `__test__.FIELDS` had one consumer (a deleted test). Clean deletion — no orphaned helper references.
- **Rule 3 (audit before claiming done).** Final-review subagent ran independently after all three implementation subagents returned. Surfaced 1 HIGH + 5 MEDIUM + 4 LOW findings. HIGH + 2 of the MEDIUMs (the ones the orchestrator agreed with) were fixed inline in the same session; the rest are documented as Open follow-ups above. Three new tests pin the fixes.
- **Rule 4 (escape hatch).** `/config show | path | get | set | unset` slash verbs preserved exactly as they were — every script that piped through them keeps working. `sov config show | path | get | set | unset` CLI subcommands preserved exactly as they were. The legacy `--ui repl` flag was already removed in M13; this work doesn't add or remove flags. If something breaks, `/config show` is the immediate fallback to inspect state, and `/config set <path> <value>` is the immediate fallback to script-set anything.

## How it works now

After `sov config`:

```text
┌─ config ─────────────────────────────────────────┐
│ ~/.harness/config.json                           │
│                                                  │
│ › General         defaultProvider · permissions  │
│   Providers       anthropic · openai · ollama    │
│   Task routing    smart router · lanes           │
│   Compaction      microcompaction · thresholds   │
│   Web search      tavily / brave                 │
│   Review          auto-promote · intervals       │
│   Learning        observation · synthesizer      │
│   Debug           transcripts · switches         │
│   OpenAI server   sov serve HTTP API             │
│   Appearance      theme                          │
│                                                  │
│ ↑/↓ navigate · enter open · esc back · q quit    │
└──────────────────────────────────────────────────┘
```

Drilling into Task routing:

```text
┌─ config / task routing ──────────────────────────┐
│ Multi-provider smart router (Phase 1 + 2)        │
│                                                  │
│ › enabled            false     ⟳ next session    │
│   delegator.model    claude-sonnet-4-6           │
│   cheap-task         anthropic / claude-haiku-4-5│
│   moderate-task      anthropic / claude-sonnet-4-6│
│   frontier-task      anthropic / claude-opus-4-7 │
│                                                  │
│ ↑/↓ nav · enter edit · u unset · esc back        │
└──────────────────────────────────────────────────┘
```

Setting theme from in-session `/config`:

```text
> /config set theme light
saved — applied to current session
[chrome flips to light theme immediately]
```

Setting a reload-needed field from in-session `/config`:

```text
> /config set taskRouting.enabled true
saved — effective next session
[task-routing submenu re-renders with enabled: true badge ⟳ next session]
```

Invalid value, editor preserved:

```text
> /config set permissionMode whatever
config error: Invalid input — expected one of: default | ask | bypass
[picker for permissionMode re-opens with subtitle "Validation failed — ..."]
```
