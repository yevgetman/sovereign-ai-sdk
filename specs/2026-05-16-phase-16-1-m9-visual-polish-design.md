# Phase 16.1 M9 — Visual Polish · Design Spec

Status: **draft** — written 2026-05-16, ready for implementation plan
Supersedes: the M9 row in `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §10 (refines that one-line scope into a per-task design)
Authority: enforces Rules 1–4 of `docs/07-history/postmortems/2026-05-12-phase-16-revert.md`

---

## 1. Purpose

Take the Phase 16.1 split-process TUI from "wire-correct" (M4–M8) to **demo-quality visible polish** so a user comparing `--ui repl` vs. `--ui tui` sees the new surface as obviously better-finished. Every existing wire event from M4–M8 stays unchanged; M9 is renderer + theme + interaction work on the Go side, with one cross-stack thread (status-line `status_update` push) on the TS side.

The differentiation axis is **visible polish craft** — smoother streaming, prettier tool cards, syntax-highlighted inline diffs with hunk navigation, fuzzy slash-command autocomplete with description preview, themed components, mouse-wheel scroll, a live status line, a styled goodbye card. The TUI does **not** add feature surface area beyond what `terminalRepl.ts` already supports. M9 is a *render-layer* milestone, not a *behavior-layer* one.

## 2. Goal

When M9 completes:

1. **Markdown rendering.** Assistant `text` blocks render with bold/italic/headers/lists/code blocks via glamour.
2. **Syntax highlighting.** Fenced code blocks in assistant text + tool input/output light up via chroma.
3. **Inline diffs with hunk navigation.** `FileEdit` / `FileWrite` tool results render as syntax-highlighted diffs; `j`/`k` cycle hunks when the diff view has focus.
4. **Styled tool cards.** `components/toolcard.go` consumes `render/` + `theme/` for collapsed/expanded states with themed borders + headers.
5. **Styled goodbye card.** `/quit` shows a full-screen styled card with tokens / cost / durations / tool counts, consuming M8 T7's rich `session_summary` event.
6. **Compaction marker card.** Inline pill in transcript when a `compaction_complete` SSE event lands.
7. **Slash autocomplete popup.** Typing `/` shows a fuzzy-matched popup of slash commands + skills with description preview; Tab to complete; Esc to dismiss.
8. **Mouse wheel scroll** in the transcript viewport. (Click-to-collapse / click-to-focus deferred to M9.5.)
9. **Theme system.** Built-in light + dark themes; `/theme <name>` slash to switch at runtime; theme persisted to `~/.harness/config.json`. **No TOML loader in M9** — deferred to M9.5.
10. **Status-line streaming indicator + live cost.** Spinner during stream; live cost on the right side; fed by a new server-side `status_update` SSE event throttled to ~10Hz.
11. **Tech-debt cleanup.** Re-enable three inherited M3 `t.Skip`'d tests (`TestApp_rendersTurnErrorVisibly`, `TestApp_showsThinkingIndicatorOnEnter`, `TestApp_thinkingClearedByFirstResponseEvent`). Backlog #29 (lipgloss `Style.Copy()` deprecation cleanup). Backlog #39 (Go TUI mirror struct for `SessionSummaryEvent`).
12. **Integration smoke** covering every above subsystem.

**Out of scope (explicit, → M9.5 or later):**

- TOML theme loader (`~/.harness/themes/*.toml`).
- Mouse click-to-focus / click-on-card-to-collapse.
- Real-Anthropic visual smoke (separate post-M9 hardening session per M7/M8 pattern).
- Per-session toolset overrides for `/skills` (carry-forward from M8).
- `/review` slash command UX in the TUI (carry-forward from M7).
- Any change to `src/ui/terminalRepl.ts` (Postmortem Rule 1 — still binding through M11).
- M10 parity audit + M11 default flip (subsequent milestones).
- Bubble Tea v2 upgrade (current v1.3.10 has mouse support already).

**Done =**

- All 12 tasks landed,
- Unit suite green on both TS + Go sides,
- Integration smoke green,
- Lint + typecheck clean,
- A user running `sov --ui tui` sees themed markdown-rendered assistant text, syntax-highlighted code, styled tool cards, slash autocomplete popup, mouse scroll, a live status line, a styled goodbye card on `/quit`.

**Explicitly NOT done in M9:** M10 parity audit, M11 default flip, real-Anthropic visual smoke (deferred to post-M9 hardening session).

## 3. Architecture

### 3.1 Two new Go packages

```
packages/tui/internal/
├── theme/                ← NEW
│   ├── theme.go          Theme struct (palette + lipgloss Style helpers)
│   ├── light.go          built-in light palette (Catppuccin Latte)
│   ├── dark.go           built-in dark palette (Catppuccin Mocha)
│   └── theme_test.go
├── render/               ← NEW
│   ├── markdown.go       glamour wrapper; themed via theme.Theme
│   ├── code.go           chroma wrapper for code blocks
│   ├── diff.go           diff hunk parser + chroma highlighter
│   ├── plain.go          fallback for non-markdown text
│   └── *_test.go
├── components/
│   ├── transcript.go     EXTEND — renders cards via render/+theme/
│   ├── toolcard.go       EXTEND — themed, consumes render/ for body
│   ├── permission.go     EXTEND — themed; #29 lipgloss Style.Copy cleanup
│   ├── prompt.go         EXTEND — themed; emits /-keystroke for autocomplete
│   ├── statusline.go     EXTEND — themed, streaming spinner, live cost
│   ├── slashautocomplete.go ← NEW — popup overlay
│   ├── goodbye.go        ← NEW — styled session-summary card
│   ├── diffview.go       ← NEW — focused diff view with j/k
│   └── compactioncard.go ← NEW — inline pill for compaction_complete
├── app/
│   ├── app.go            EXTEND — mouse handler, slash routing, theme injection
│   ├── keys.go           EXTEND — j/k when diff focused; /theme dispatch
│   └── ...
└── transport/
    └── types.go          EXTEND — Go mirror for SessionSummaryEvent (#39)
```

### 3.2 TS-side touches (minimal)

- `src/server/schema.ts` — verify `StatusUpdateEvent` schema present (may already exist from spec §5; add if missing).
- `src/server/routes/turns.ts` — emit `status_update` events at usage-delta points during the stream. Throttle to ~100ms (10Hz). Emit final flush on `turn_complete`.
- `terminalRepl.ts` UNTOUCHED.

### 3.3 SSE events consumed

| Event | Shipped in | M9 use |
|---|---|---|
| `text_delta` | M3 | passes through `render/markdown.go` (debounced) |
| `tool_use_start` / `tool_use_done` / `tool_result` | M3 | passes through `render/` via `toolcard.go` |
| `compaction_complete` | M6 | new `compactioncard.go` inline marker |
| `permission_request` | M5 | already rendered; themed in M9 (#29) |
| `stall_detected` | M8 | M9 renders as status-line badge (small, non-blocking; auto-fade 5s) |
| `session_summary` (rich) | M8 | new `goodbye.go` consumes all fields |
| `status_update` | **M9 (new emission)** | new statusline streaming spinner + live cost |

### 3.4 Model/Update/View threading

Theme is constructed once at boot from `~/.harness/config.json`'s `theme` field (default `dark`) and injected into the root `app.Model`. Every component receives `theme.Theme` via its `New(...)` constructor — no global. The `/theme <name>` slash handler updates `model.theme` and dispatches a `themeChanged` `tea.Msg` that causes every visible component to re-render. Slash autocomplete state lives on `model.autocomplete` (visible/hidden + filter + selected index); shown when prompt input starts with `/`, dismissed on Esc / Enter / out-of-match. Diff view focus state lives on `model.focus` (transcript | diffview | autocomplete); `j`/`k` only do hunk nav when focus is `diffview`.

### 3.5 Architecture rules

- `internal/render/*` is pure: takes text + theme + sizing, returns a string with ANSI. No `tea.Msg`. No state.
- `internal/theme/*` is pure: returns a `Theme` struct with `lipgloss.Style` field accessors. No globals.
- `internal/components/*` owns `tea.Model` shape; consumes render+theme via constructor injection.
- `internal/app/*` owns input routing + focus state + the slash-keystroke decision tree.

## 4. Decisions Locked In This Spec

Recorded as ADR stubs in `DECISIONS.md` at close-out.

1. **M9-01** — Theme construction is constructor-injected, no global. Every component takes `theme.Theme` in its `New(...)`.
2. **M9-02** — `internal/render/*` is pure: `(text, theme, width) → string`. No `tea.Model`, no `tea.Msg`, no I/O.
3. **M9-03** — TOML theme loader deferred to M9.5. Built-in light + dark only in M9.
4. **M9-04** — `status_update` live-cost source = server-pushed via SSE event, throttled ~10Hz (100ms debounce).
5. **M9-05** — Slash autocomplete fetches commands + skills at startup; invalidates cache on `compaction_complete` (matches M8 T6 skill-cache pattern).
6. **M9-06** — Mouse v1 = wheel-scroll only. Click-to-collapse / click-to-focus deferred to M9.5.
7. **M9-07** — `/expand` ring buffer (M8 T6) untouched in M9. Diff view focus is separate state from expand.
8. **M9-08** — Compaction marker card is an *inline transcript element*, not a status-line indicator.
9. **M9-09** — Goodbye card degrades gracefully when M7-shape `session_summary` lands without M8 extension fields.
10. **M9-10** — `src/ui/terminalRepl.ts` untouched (Postmortem Rule 1, again). All M9 code lives parallel-additive in `packages/tui/` and `src/server/`.
11. **M9-11** — Theme palette = Catppuccin (Mocha for dark, Latte for light). Well-known, free-to-use, AA-contrast tested.
12. **M9-12** — `/theme <name>` is a dedicated slash command; falls through to existing config-set semantics internally.

## 5. Task Decomposition

12 tasks. Each is a single commit. Each ships with its tests; full suite must stay green at each commit.

| # | Task | Touches | Test target |
|---|---|---|---|
| **T1** | Theme package foundation | NEW `internal/theme/` (theme.go + light.go + dark.go + theme_test.go); `/theme <name>` slash handler in `app.go` updates `model.theme`. | Go unit: light + dark palettes load; `/theme dark` updates model; unknown theme returns error. |
| **T2** | Renderer package foundation | NEW `internal/render/` (markdown.go via glamour + code.go via chroma + plain.go + tests). Pure functions. Add glamour + chroma to `go.mod`. | Go unit: markdown bold/italic/headers render; chroma highlights go/ts/py code blocks; plain fallback when markdown parse fails. |
| **T3** | Markdown wiring into transcript | EXTEND `components/transcript.go` — assistant `text` blocks render through `render/markdown.go`; debounce streaming card re-render to ~60Hz. | Go unit: streaming text_delta events build up assistant card; final rendered string contains expected ANSI sequences. |
| **T4** | Syntax highlight on code blocks | EXTEND `components/transcript.go` + `components/toolcard.go` — fenced code blocks + tool input/output use `render/code.go`. | Go unit: tool result with `language: 'go'` gets chroma-highlighted; missing language hint falls back to plain. |
| **T5** | Inline diff renderer + hunk nav | NEW `internal/render/diff.go` (parser + highlighter) + `components/diffview.go` (focused state, j/k bindings). EXTEND `components/toolcard.go` to route `FileEdit`/`FileWrite` through diff renderer. | Go unit: hunk parser splits multi-hunk diff; j/k cycles `model.diffview.activeHunk`; out-of-range clamps. |
| **T6** | Styled tool cards | EXTEND `components/toolcard.go` end-to-end with theme tokens; collapsed/expanded states; per-tool input + output styling. | Go unit: card renders collapsed by default; expand toggles full output; theme tokens applied to header/body/border. |
| **T7** | Goodbye card + compaction marker + #39 mirror | NEW `components/goodbye.go` (consumes rich `session_summary`); NEW `components/compactioncard.go` (inline pill on `compaction_complete`); EXTEND `transport/types.go` with Go mirror for `SessionSummaryEvent` (closes #39). | Go unit: goodbye card renders all fields when present + degrades gracefully to M7-shape; compaction card renders on event. |
| **T8** | Slash autocomplete popup | NEW `components/slashautocomplete.go` (popup overlay + fuzzy matcher). EXTEND `app/app.go` to route `/` keystroke. Fetches `GET /commands` (slash list) + `GET /sessions/:id/skills` (M8 T4 surface). | Go unit: typing `/sk` filters to `skill-*` entries; Tab completes; Esc dismisses; Enter dispatches. |
| **T9** | Mouse wheel scroll | EXTEND `app/app.go` — enable Bubble Tea mouse mode; wheel-up/down scrolls transcript viewport. | Go unit: mouse-wheel `tea.Msg` events update `model.transcript.scrollOffset`. |
| **T10** | Status-line streaming indicator + live cost | TS side: `src/server/routes/turns.ts` emits `status_update` SSE events on usage_delta (throttled ~100ms). NEW `tests/server/turns.statusUpdate.test.ts`. Go side: EXTEND `components/statusline.go` — consume new event; spinner when `streaming: true`; live cost on right. | TS unit: status_update emitted with expected fields, throttled. Go unit: spinner toggles on streaming flag; cost field updates. |
| **T11** | Cleanup — t.Skip + #29 + #39 verify | (a) Re-enable + fix three `t.Skip`'d tests in `internal/app/app_test.go` (root cause: teatest WaitFor polling race; fix via deterministic event sequencing). (b) Replace lipgloss `Style.Copy()` with non-deprecated equivalent in `components/permission.go` (#29). (c) Verify #39 lands in T7. | Go: 3 previously-skipped tests pass; lint clean. |
| **T12** | Integration smoke + close-out | NEW `tests/server/m9Full.test.ts` (TS smoke for wire surface). NEW `packages/tui/internal/app/m9Full_test.go` (Go smoke for visible surfaces). Update `docs/07-history/state/2026-05-XX.md`; close ADRs M9-01 through M9-12; update CLAUDE.md/AGENTS.md pointers; close backlog #29 + #39. | TS + Go suites green; lint + typecheck clean; CLAUDE.md ≡ AGENTS.md byte-identical mirror. |

**Dependency graph:**

- T1, T2 parallel-safe (theme + render are independent foundation packages).
- T3 depends on T1 + T2.
- T4 depends on T2 (chroma).
- T5 depends on T2 + T1.
- T6 depends on T1 + T2 + T4 + T5.
- T7 depends on T1 + T2.
- T8 depends on T1.
- T9 independent.
- T10 independent.
- T11 independent.
- T12 depends on T1–T11.

## 6. Error Handling

Per `docs/05-conventions/coding-style.md` (fail-explicit, no silent swallow):

- **Renderer failures** (glamour/chroma parse error on user-provided text): fall back to `render/plain.go`; do not propagate. The TUI must never crash on garbage input from the model.
- **Theme load failure** (config.json has unknown theme name): warn to debug log, fall back to `dark`. Do not block boot.
- **Slash autocomplete fetch failure** (server 5xx on `/commands` or `/skills`): popup shows whichever fetch succeeded; if both fail, show empty list with `"fetch failed"` annotation. User can still type the slash without completion.
- **Diff parser failure** (malformed diff content): fall back to plain-text rendering of the tool result. Log to debug only.
- **`status_update` event missing fields** (older server, partial payload): statusline renders what's present, leaves missing fields blank. No nil deref.
- **`session_summary` M7-shape** (extension fields absent): goodbye card renders M7-shape minimum (totalDispatched + byAgent); skips the tokens/cost section gracefully.
- **Mouse events on terminals that don't support them**: Bubble Tea no-ops; no error path needed.

## 7. Testing Strategy

Mirrors M8's pattern; scaled for Go-heavy work.

| Layer | Per-task | At T12 close-out |
|---|---|---|
| **TS unit** (`bun test`) | T10 adds `tests/server/turns.statusUpdate.test.ts`. T12 adds `tests/server/m9Full.test.ts` integration smoke. Other tasks are Go-only. | Suite stays at 1991+ (no regressions). Lint + typecheck clean. |
| **Go unit** (`go test ./...`) | Every component + render + theme file gets a `_test.go` peer. | All Go packages green; T11 specifically re-enables 3 inherited M3 `t.Skip`'d tests. |
| **Integration smoke** (T12) | NEW `tests/server/m9Full.test.ts` (TS wire-surface smoke); NEW `packages/tui/internal/app/m9Full_test.go` (Go Model-level smoke). | Both files green; teatest deterministic (no races). |
| **Lint + typecheck** | Per-commit gate. | Same 2 pre-existing warnings only; `lipgloss.Style.Copy()` deprecation cleared by T11. |
| **Real-Anthropic visual smoke** | NOT in M9. Deferred to post-M9 hardening session (same shape as `scripts/m8-real-smoke.ts`). | Out of scope for T12. |
| **`sov upgrade` after every `packages/tui/` change** | Per `docs/05-conventions/sov-upgrade.md`. | Final close-out `sov upgrade` verifies `bin/sov-tui` builds from postinstall. |

**Visual / manual verification (alongside automated tests):**

- After T3: `sov --ui tui` shows assistant text with bold/italic/headers rendered.
- After T4: assistant code blocks light up.
- After T5: a `FileEdit` tool result renders as syntax-highlighted diff; `j` cycles to next hunk.
- After T6: tool cards have themed borders + headers.
- After T7: `/quit` shows styled goodbye card; mid-session `/compact` shows inline pill.
- After T8: typing `/` shows popup with matching commands + skills.
- After T9: mouse wheel scrolls transcript.
- After T10: status line shows spinner while streaming and live cost on right.
- After T11: `go test ./...` is green with no skips.

## 8. Postmortem-Rule Compliance Check

Verified at close-out:

- **Rule 1** — `src/ui/terminalRepl.ts` untouched: `git diff master -- src/ui/terminalRepl.ts` returns empty.
- **Rule 2** — no helper module deletion: `git diff master --diff-filter=D -- src/` returns empty.
- **Rule 3** — parity audit: NOT done in M9. That's M10's job. M9 close-out states explicitly that parity is not asserted.
- **Rule 4** — `--ui tui` stays opt-in through M11: `src/main.ts` default still `repl`.

## 9. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `glamour` performance on long streaming deltas | medium | Debounce re-render on `text_delta` to ~60Hz; only re-render current assistant card, not full transcript; benchmark in T3 with 50KB streamed response. |
| `chroma` lexer selection for ambiguous languages | low | Default to plain when language hint absent; opt-in to lexer guessing later if needed. |
| Teatest race on the 3 inherited skipped tests | medium | T11 fix uses deterministic event sequencing (drain events synchronously before assertion), not `WaitFor` polling. |
| `lipgloss.Style.Copy()` cleanup might break visual diff | low | T11 runs visual smoke after the replacement; compares before/after render output as byte equality. |
| `status_update` throttle in TS race condition (multiple in-flight requests) | low | T10 implements throttle per-session-id, not global; each session has its own debounce timer. |
| Mouse mode breaks on terminals without support | low | Bubble Tea no-ops; document `--no-mouse` flag opt-out for M9.5 if any user reports issues. |
| Bubble Tea v1.3.10 mouse API differences from v2 | low | Verify in T9 with `tea.WithMouseCellMotion()` or `tea.WithMouseAllMotion()`; lipgloss + bubbles compatibility matrix already pinned. |
| Glamour/chroma add binary size | low | Both are pure Go, lightweight; postinstall `go build` size delta acceptable. |

## 10. Open Questions Deferred To Plan-Time

These become entries in the implementation plan's "Inline Decisions" table (M8 pattern):

1. **`/theme` slash command surface.** Standalone `/theme <name>` slash, or `/config set theme <name>` reusing existing `/config`? Recommendation: dedicated `/theme` for discoverability; falls through to `/config set theme` internally.
2. **Slash autocomplete trigger.** Popup on `/` keypress (immediate) or after first match (`/<letter>`)? Recommendation: immediate on `/` — matches opencode and `gh` CLI behavior.
3. **Diff view focus model.** Click-on-tool-card-with-diff to focus, or keybind to cycle focus? Recommendation: dedicated keybind `Ctrl+]` to focus most-recent diff, Esc to defocus. Click-to-focus is M9.5 mouse expansion.
4. **`status_update` throttle implementation.** `setInterval` per-session or debounce-then-flush at next `usage_delta`? Recommendation: debounce at the route — emits at most every 100ms while in-flight; emits immediately on `turn_complete` to flush final state.
5. **Goodbye card trigger.** On every `/quit` regardless of session length, or only when session ran >1 turn? Recommendation: always show on `/quit` (consistent UX); skip on Ctrl+C-abort.
6. **Compaction marker visual style.** Inline pill spanning full width, or right-aligned timestamp+icon? Recommendation: full-width pill with a `« compacted N turns »` label — same shape as a system message.
7. **`stall_detected` badge persistence.** Show until next turn starts, or auto-fade after N seconds? Recommendation: fade after 5s; refresh-on-second-stall stacks the badge.
8. **Mouse mode flag.** Always on (Bubble Tea default) or behind `--mouse` opt-in? Recommendation: always on; defer `--no-mouse` flag to M9.5 if any user reports breakage.

## 11. Integration With The Umbrella Roadmap

M9 sits between M8 (polish-surfaces parity wiring — shipped 2026-05-16) and M10 (independent parity audit per Postmortem Rule 3). M11 default-flips `--ui tui` to default; M12–M13 deprecate then remove `terminalRepl.ts`.

M9 does NOT assert parity with `terminalRepl.ts`. M10 will read the import list of `terminalRepl.ts` and confirm every imported subsystem has a corresponding wiring in the server-mode / TUI path. Failed parity items either get fixed in M10 cleanup or block M11.

## 12. Self-Review

Spec checked against the brainstorming-skill checklist 2026-05-16-pre-commit:

- **Placeholder scan:** No "TBD", "TODO", or incomplete sections. T12's state-snapshot filename is `2026-05-XX.md` because the close-out date is unknown at spec-write time; resolves to actual date in the plan.
- **Internal consistency:** Architecture (§3) matches Task list (§5) feature descriptions. SSE event consumption (§3.3) matches the event names in §5 + §6.
- **Scope check:** 12 tasks within M8's 8-task precedent + 4 new items. Roughly 2-3 sessions. Single implementation plan handles it.
- **Ambiguity check:** Theme name strings (`"dark"`, `"light"`) are the canonical case. Diff view focus is the orthogonal model from `/expand` ring buffer (§M9-07). Per-component constructor injection of theme is explicit (§3.1).

## 13. Next Steps

1. Write implementation plan at `plans/2026-05-16-phase-16-1-m9-visual-polish.md` via `superpowers:writing-plans` skill.
2. Execute T1–T12.
3. Close-out: state snapshot + CLAUDE.md/AGENTS.md pointer updates + backlog closures (#29, #39) + ADRs in DECISIONS.md.
4. Push to origin/master after each commit per `docs/05-conventions/lint-and-commit.md`.
