# Phase 16.1 M11.5 — Inline picker card for the TUI

**Date:** 2026-05-19
**Status:** Awaiting plan-execution authorization.
**Predecessor:** M11 default-flip (`docs/07-history/state/2026-05-17-m11.md`); also depends on M10.5 dispatcher route (`specs/2026-05-16-phase-16-1-m10-5-slash-dispatcher-design.md`).
**Reference:** Claude Code's inline-card picker (user-supplied screenshot `~/Desktop/goodux.png`).

## 1. Purpose

`/model`, `/resume`, and `/export` are picker-driven slash commands in `src/commands/pickers.ts` + `src/commands/sessionOps.ts`. Their no-arg form calls `pick()` from `src/ui/picker.ts`, which uses raw-mode + full-screen render — designed for the readline REPL where the REPL hands over the terminal for the duration of the pick.

Under M11 (TUI default), invoking `/model` (no args) dispatches via the M10.5 route to the server. The server runs `pick()`, which writes raw-mode escape codes to stdout. The Go TUI is *simultaneously* painting its own layout. The two render loops collide: items cascade diagonally, `(current)` floats untethered, and the user cannot reliably select anything (`~/Desktop/ux1.png`).

The architecturally correct fix is to **decouple picker state from picker rendering**:
- The server emits *intent* (what to pick, what the options are).
- The TUI owns *rendering* (inline card matching Claude Code's reference UX).

This generalizes. `/model`, `/resume`, `/export` use the same protocol today, and every future picker-driven slash command rides the protocol for free. The alternative — per-command text fallbacks — sets a precedent of patching forever.

## 2. Scope

**In scope (M11.5):**
- New `requestPicker` capability on `CommandContext` (server-side implementation only).
- New `pickerOpen` field in the dispatcher response envelope.
- Migrate `/model`, `/resume`, `/export` to emit `pickerOpen` when no args are supplied AND `ctx.requestPicker` exists.
- New Go TUI component `PickerCard` (inline, scroll-flow, ↑↓/Enter/Esc).
- Wire `pickerOpen` → `PickerCard` in `packages/tui/internal/app/app.go`.
- Selection re-dispatches `/{command} <value>` through the existing M10.5 route; cancellation closes the card with no further dispatch.
- Spacing fix: blank line between `…running /<command>` indicator and the input prompt (`~/Desktop/ux2.png`).
- Tests: server envelope, Go card render + navigation, end-to-end real-Anthropic smoke.
- 3 ADRs.

**Out of scope:**
- Migrating `/theme` to the new protocol. `/theme` already works in the TUI via dedicated client-side dispatch (one of the original 4 entries in `staticEntries`). Migration would be churn for parity; deferred. Filed as M11.5 follow-up.
- Readline-REPL migration to the new card. The legacy `pick()` path stays for the REPL surface. M12 (terminalRepl deprecation) will eventually retire the REPL entirely; until then, the two surfaces have different picker implementations but the same user-visible behavior.
- Server-side continuation tokens (resumable command state). The selected value is dispatched as a *fresh* `/{command} <value>` call. See ADR M11.5-03.
- Concurrent pickers. Only one picker may be open per session at a time. If a second `/model` arrives while a picker is open, the server returns an informative error.

## 3. Architecture

```
User types "/model" (no args) + ENTER
  │
  ↓
Go TUI:
  dispatcher.Send("/model", "")
  │
  ↓
Server (Hono):
  POST /sessions/:id/commands { name: "model", args: "" }
  │
  ↓
  dispatchSlashCommand("model", "", ctx)
    │
    ↓
    runModelPicker("", ctx):
      if ctx.requestPicker exists:
        ctx.requestPicker({
          title: 'switch model',
          subtitle: 'provider: anthropic',
          items: [{label, value, hint?}, ...],
          initial: 2,
          onSelect: { command: 'model' },
        })
        return ''                              // empty text output
      else (legacy REPL path):
        // existing pick() flow
  │
  ↓
Server response:
  { output: '', sideEffects: { pickerOpen: { ... } } }
  │
  ↓
Go TUI:
  app.handlePickerOpen(payload):
    state.picker = NewPickerCard(payload)
    state.inputLocked = true
  │
  ↓
User navigates ↑↓, presses ENTER on selection
  │
  ↓
Go TUI:
  state.picker.View() = card render
  on ENTER:
    value := state.picker.Selected()
    state.picker = nil
    state.inputLocked = false
    dispatcher.Send("/model", value)            // fresh dispatch
  │
  ↓
Server response:
  { output: "model set to claude-sonnet-4-6 (persisted to session …).",
    sideEffects: { modelChanged: "claude-sonnet-4-6" } }
  │
  ↓
Go TUI:
  Append output to scrollback. Apply modelChanged side-effect (status line update).
```

Cancellation path (Esc):
```
Go TUI:
  state.picker = nil
  state.inputLocked = false
  // optional: append "cancelled." to scrollback for affordance
```

No server-side state. The picker payload is self-contained; the resolution is a fresh dispatch carrying the chosen value.

## 4. Components

### 4.1 Server-side (TypeScript)

**`src/commands/types.ts` (CHANGED)** — extend `CommandContext` and the dispatcher result type:

```typescript
export interface PickerOpenConfig {
  title: string;
  subtitle?: string;
  items: Array<{
    label: string;
    value: string;
    hint?: string;
  }>;
  initial?: number;
  /** Command to dispatch with the selected value as args. */
  onSelect: { command: string };
}

export interface CommandContext {
  // ... existing fields
  /** Server-mode only: emit a picker side-effect. Absence means legacy
   *  in-process pick() should be used (readline REPL path). */
  requestPicker?: (config: PickerOpenConfig) => void;
}
```

The dispatcher's response envelope already supports `sideEffects` (M10.5). Add `pickerOpen?: PickerOpenConfig` to the side-effects shape.

**`src/server/commandContext.ts` (CHANGED)** — `buildServerCommandContext` populates `requestPicker`:

```typescript
const sideEffects = new Map<string, unknown>();

const ctx: CommandContext = {
  // ... existing fields
  requestPicker: (config) => {
    if (sideEffects.has('pickerOpen')) {
      throw new Error('a picker is already open for this command dispatch');
    }
    sideEffects.set('pickerOpen', config);
  },
};
```

**`src/commands/pickers.ts` (CHANGED)** — `runModelPicker` and `runResumePicker` gain a `requestPicker` branch:

```typescript
async function runModelPicker(args: string, ctx: CommandContext): Promise<string> {
  const explicit = args.trim();
  if (explicit) {
    ctx.setModel(explicit);
    return `model set to ${explicit} (persisted to session ${ctx.sessionId.slice(0, 8)}).`;
  }
  const models = PROVIDER_MODELS[ctx.providerName] ?? [];
  if (models.length === 0) { /* unchanged: error message */ }

  // New server-mode branch
  if (ctx.requestPicker) {
    ctx.requestPicker({
      title: 'switch model',
      subtitle: `provider: ${ctx.providerName}`,
      items: models.map((name) => ({
        label: name,
        value: name,
        ...(name === ctx.model ? { hint: '(current)' } : {}),
      })),
      initial: Math.max(0, models.findIndex((m) => m === ctx.model)),
      onSelect: { command: 'model' },
    });
    return '';
  }

  // Legacy REPL branch — unchanged
  if (!process.stdin.isTTY) { /* ... */ }
  // ... existing pick() flow
}
```

Same shape for `runResumePicker` (in `pickers.ts`) and `runExport` (in `sessionOps.ts`).

### 4.2 Go TUI

**`packages/tui/internal/transport/picker.go` (NEW)** — wire types mirroring the server payload:

```go
type PickerItem struct {
    Label string `json:"label"`
    Value string `json:"value"`
    Hint  string `json:"hint,omitempty"`
}

type PickerOpenPayload struct {
    Title    string       `json:"title"`
    Subtitle string       `json:"subtitle,omitempty"`
    Items    []PickerItem `json:"items"`
    Initial  int          `json:"initial,omitempty"`
    OnSelect struct {
        Command string `json:"command"`
    } `json:"onSelect"`
}
```

**`packages/tui/internal/components/pickercard.go` (NEW, ~180 LoC)** — Bubble Tea component:

```go
type PickerCard struct {
    payload  transport.PickerOpenPayload
    selected int
    theme    theme.Theme
    width    int
}

func (p *PickerCard) MoveDown() { /* clamp */ }
func (p *PickerCard) MoveUp()   { /* clamp */ }
func (p *PickerCard) Selected() string { return p.payload.Items[p.selected].Value }
func (p *PickerCard) Command() string  { return p.payload.OnSelect.Command }
func (p *PickerCard) View(width int) string {
    // - Title (bold, accent color)
    // - Subtitle (dim) — optional
    // - Items: "› <label>  <hint>" for selected (theme accent),
    //          "  <label>  <hint>" for others
    // - Footer (dim, italic): "↑/↓ navigate · enter confirm · esc cancel"
    // - Wrap in theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
}
```

Visual reference: `~/Desktop/goodux.png`. Inline in scroll flow, NOT full-screen. Matches the existing `SlashAutocomplete` popup pattern (same `CardBorderStyle()`).

**`packages/tui/internal/app/app.go` (CHANGED)** — handle `pickerOpen` side-effect and lock input while open:

- On dispatcher response, if `sideEffects.pickerOpen` is present, instantiate `PickerCard` and store in app state.
- While `app.picker != nil`:
  - ↑ → `picker.MoveUp()`
  - ↓ → `picker.MoveDown()`
  - Enter → dispatch `/{picker.Command()} {picker.Selected()}`; clear `app.picker`
  - Esc → clear `app.picker` (optionally append "cancelled.")
  - All other keys: ignored
- The picker's `View()` renders below the scrollback and above the input prompt.

### 4.3 Spacing fix

`~/Desktop/ux2.png` shows the `…running /<command>` indicator butting up against the input prompt. Add a blank-line spacer in the relevant view path (likely the status / running indicator render). One-line change in the TUI layout.

## 5. Tests

**Server-side:**
- `tests/server/picker.test.ts` — `buildServerCommandContext` returns a `requestPicker` that records `pickerOpen` in `sideEffects`. Double-emission throws.
- `tests/commands/pickerEnvelope.test.ts` — dispatching `/model` (no args) with a server context returns `{ output: '', sideEffects: { pickerOpen: {...} } }`. Dispatching `/model <name>` (with args) returns the existing text and `modelChanged` side-effect.
- Same for `/resume` and `/export` no-args / with-args.

**Go TUI:**
- `packages/tui/internal/components/pickercard_test.go` — render output snapshots; ↑↓ clamps; Selected() returns expected value; PopupHeight; theme switching.
- `packages/tui/internal/app/picker_dispatch_test.go` — pickerOpen side-effect → app.picker set; Enter → outbound dispatcher call with correct command+args; Esc → app.picker cleared, no outbound call.

**End-to-end:**
- `tests/parity/m11_5PickerSmoke.test.ts` (env-gated, real-Anthropic) — dispatch `/model`, expect pickerOpen envelope, dispatch follow-up `/model claude-sonnet-4-6`, expect modelChanged side-effect. ~$0.005.

**Coverage matrix:**

| Surface | `/model` (no args) | `/model <name>` | `/resume` | `/export` |
|---|---|---|---|---|
| TUI (server route) | pickerOpen | modelChanged | pickerOpen | pickerOpen |
| REPL (in-process) | pick() (unchanged) | modelChanged | pick() (unchanged) | pick() (unchanged) |

## 6. ADRs

### ADR M11.5-01 — Picker as side-effect on CommandContext

**Decision:** Add an optional `requestPicker(config)` method to `CommandContext`. Picker commands check its presence: emit a side-effect when present (server mode), fall back to inline `pick()` when absent (REPL mode).

**Alternatives considered:**
- (a) Separate HTTP route per command (`POST /sessions/:id/pickers/model`). Rejected: proliferates routes; the dispatcher route is the unified entry point per M10.5 / ADR M10.5-01.
- (b) Generic `pickerOpen` side-effect on every command unconditionally. Rejected: breaks legacy REPL path that expects `pick()` to return synchronously.
- (c) Pass a renderer function through CommandContext (REPL passes its terminal renderer; server passes a side-effect recorder). Rejected: over-generalized; commands shouldn't know about render surfaces.

**Why this:** Minimal diff. REPL untouched. Server mode is gated by capability detection (`ctx.requestPicker !== undefined`), so future commands automatically benefit. Mirrors the existing `cleanupPhantomReviews` capability-detection pattern in `CommandContext`.

### ADR M11.5-02 — REPL kept on legacy `pick()` for M11.5

**Decision:** The readline REPL surface continues to use in-process `pick()` for picker commands. The TUI surface uses the new inline card. Two implementations, one user-visible behavior.

**Alternatives considered:**
- (a) Migrate the REPL to render-via-`PickerCard` too. Rejected: the readline REPL doesn't have a render loop; would require building one or invoking the Go binary as a sub-process, both substantial work for a surface that M12 is going to retire anyway.
- (b) Retire `/model`, `/resume`, `/export` from the REPL entirely. Rejected: those commands are documented and used; removal is a regression on the REPL surface.

**Why this:** M12 (terminalRepl deprecation) is the natural endpoint for unifying picker implementations. Until then, capability detection keeps both paths working without coupling.

### ADR M11.5-03 — Resolution via fresh dispatch (no continuation tokens)

**Decision:** When the user selects from the picker, the Go TUI dispatches `/{command} <value>` as a fresh slash command. The server does NOT maintain suspended-command state across the picker round-trip.

**Alternatives considered:**
- (a) Continuation tokens — server stores `{ pickerId, originalCommand, originalArgs, resumeFn }` and resumes after the client POSTs the selection. Rejected: stateful server; complicates timeout / cleanup / restart semantics; gains nothing the fresh-dispatch path doesn't already give us.
- (b) Long-poll: server holds the request open while the picker is rendered, client streams the selection back over the same connection. Rejected: HTTP timeouts on slow user selection; complicates the dispatcher's request/response model.

**Why this:** Stateless server. Idempotent. The arg-form (`/model claude-sonnet-4-6`) already works; the picker just collects the arg. The picker render is purely client-side state.

## 7. Migration order

1. T1 — Type definitions: `PickerOpenConfig`, `CommandContext.requestPicker`, side-effect envelope shape.
2. T2 — Server: `buildServerCommandContext` populates `requestPicker`. Tests.
3. T3 — Migrate `runModelPicker` with the `requestPicker` branch. Tests.
4. T4 — Go TUI: `PickerCard` component + tests.
5. T5 — Wire `pickerOpen` → `PickerCard` in `app/app.go`. Lock input. Tests.
6. T6 — Wire Enter (dispatch selection) and Esc (cancel). Tests.
7. T7 — Migrate `runResumePicker` and `runExport`. Tests.
8. T8 — Spacing fix for `…running /<command>` indicator.
9. T9 — Real-Anthropic E2E smoke (env-gated).
10. T10 — Close-out: backlog header update, testing log, ADRs land with the spec, `sov upgrade`.

## 8. Out-of-scope follow-ups

- **F1** — Migrate `/theme` from dedicated client-side dispatch to `pickerOpen` for consistency. Filed as M11.5 follow-up.
- **F2** — Readline REPL renders pickers via `PickerCard`-equivalent (sub-process or in-process render loop). Likely closed by M12 (terminalRepl deprecation) instead.
- **F3** — Picker timeout / abandonment cleanup. With statelessness (ADR M11.5-03), this is a no-op server-side; client-side may want a "you abandoned the picker 5 min ago" affordance.

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `PickerCard` render fights other inline cards (autocomplete popup, permission modal) | Medium | Mutex via app state: only one inline card at a time. Permission modal already follows this pattern. |
| Capability detection regression: REPL CommandContext accidentally gains `requestPicker` | Low | Tests assert `buildCliCommandContext` (REPL) returns `ctx.requestPicker === undefined`. |
| Selected value contains characters that break the second dispatch's parsing | Low | Model names are URL-safe ASCII; `pick()` doesn't currently quote values either. If a future picker needs richer values, escape at the Go-side dispatch layer. |
| User opens picker, ignores it, types other text | Low | Input is locked while picker is open; only ↑↓/Enter/Esc are handled. Visually obvious card overlay. |
| Picker-open dispatch returns empty output + pickerOpen, but TUI ignores pickerOpen and just shows empty | Medium | Test (T5) asserts the empty-output case is routed to `handlePickerOpen` when pickerOpen is present. |
