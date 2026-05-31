# TUI UX patterns — design rules learned across M11.x

**When to read:** Before changing layout, chrome, or visual behavior in
`packages/tui/`. The M11–M11.13 milestone arc shipped about a dozen
small UX iterations; these are the resulting rules. Read this AND
[`tui-color-rendering.md`](tui-color-rendering.md) before touching
anything visual.

## Companion docs

- [`tui-color-rendering.md`](tui-color-rendering.md) — the color rule
  (body text inherits terminal default; only accents get colors).
  Discovered M11.5–M11.10. Most-cited rule in this file too.
- **Style guide** (`packages/tui/internal/style/`) — the global,
  immutable TUI style guide. All spacing, padding, margins, glyphs,
  brand colors, and typography tokens live here. Components reference
  `style.S.*` instead of hardcoding values. Themes remain separate
  for switchable color palettes.

---

## Layout & flow

### Inline mode: no alt screen, terminal owns scrollback (ux-fixes round 5)

The TUI runs **without** `tea.WithAltScreen()`. Wheel + trackpad scroll
and text selection / copy work natively through the terminal — there's
no in-TUI scroll subsystem to wire. Permanent content (user messages,
finalized assistant cards, tool results, system messages, splash,
boot notices) emits via `tea.Println` into the terminal's natural
scrollback ABOVE the live View. Mid-session content can be re-read
by scrolling the terminal up.

`View()` shrinks to the bottom anchor:

```
[m.live.View()]       — streaming card + spinner + "…running" (any may be empty)
[stallBadge / picker] — when active
""                    — spacer
[prompt]              — auto-grown rounded-border textarea
[autocomplete popup]  — when prompt starts with /
[hint line]           — "? for shortcuts"
[statusLine]          — cwd · profile · model · cost · cache
```

No `maxHeight` calculation, no `rebuildHeight`, no atBottom tracking,
no scroll keybindings. The terminal handles all that natively.

### Print queue + drain pattern

Use `m.print(line)` / `m.printUser(text)` to queue content for terminal
scrollback. At the end of every Update branch, `m.respond(cmd)`
batches the caller's Cmd with `m.drainPrintln()` — a single
`tea.Println` consolidating the queue (newline-joined so order is
preserved). `m.emittedPrintln` retains the drained snapshot for test
inspection via the `scrollbackContent(m)` helper.

`m.printUser` wraps the text via `lipgloss.NewStyle().Width(w-2).Render`
so multi-line submissions hang-indent under the "❯ " marker.
Submissions above `userMessageDisplayCap = 1500` chars are truncated
in the echo with a dim italic ` …[+N chars]` marker (the full text
still ships in the actual turn — the truncation is the visual receipt).

### Splash + boot notices appear ONCE in terminal scrollback

The SOV splash logo, info card, tips line, and boot notices ("running
in $HOME", "no bundle detected") emit via `m.print(...)` on the first
`WindowSizeMsg`. They land in the terminal's natural scrollback above
the live View and scroll up as new content arrives — no permanent
chrome.

**Guard:** Splash is gated on `!m.splashShown && m.baseURL != ""`.
- `splashShown` prevents re-rendering on subsequent `WindowSizeMsg`.
- `baseURL != ""` skips splash in render-only unit tests that use
  empty baseURL.

### Spacers, not absolute positioning

`View()` returns a single string that Bubble Tea writes top-to-bottom.
Use `"\n"` spacers between logical sections instead of trying to
position elements absolutely. Current order:

```
m.live.View()         — streaming card + spinner + "…running"
[stallBadge.View()]   — when active
[picker.View()]       — when active
"\n" + prompt + "\n"  — spacer, then auto-grown textarea
[autocomplete.View()] — when prompt starts with /
[hint + "\n"]         — "? for shortcuts"
statusLine.View()     — cwd · profile · model · cost · cache
```

Boot notices used to render between transcript and prompt; they were
moved into transcript content in M11.6 and now (round 5) emit via
`m.print` into terminal scrollback so they scroll away naturally.

---

## Visual identity

### SOV logo gradient: blue → teal → purple → pink (top to bottom)

The ANSI Shadow "SOV" logo applies one color per row from a
6-element gradient:

```
#4f8fff  electric blue   (row 0)
#22d3ee  cyan-teal       (row 1)
#14b8a6  teal            (row 2)
#a78bfa  soft purple     (row 3)
#d946ef  magenta         (row 4)
#ec4899  pink            (row 5)
```

Mirrors Qwen Code's QWEN logo (which sweeps left-to-right) re-oriented
top-to-bottom. **Theme-independent** — the logo is a brand cue, not a
status surface. Same colors on every theme.

Location: `packages/tui/internal/components/splash.go:logoGradient`.

### Spinner uses the same gradient (compressed to 4 anchors)

The thinking spinner's `thinkingSpinnerGradient` cycles through the
brightest hex from each anchor band:

```
#4f8fff → #22d3ee → #a78bfa → #ec4899
```

Color advances every 3 glyph frames (`frame/3 mod 4`), so the
gradient sweep reads as a slow undertone beneath the 10-frame
Braille rotation. 40 distinct visual states before the loop repeats.

Glyph cadence: 80ms (12.5 fps). Slower feels sluggish; faster feels
like a strobe.

Location: `packages/tui/internal/components/spinner.go`.

### Info card sits inside a rounded border

The splash's right-side info card (version, provider | auth, model,
cwd) is wrapped in a `lipgloss.RoundedBorder()` with `theme.Border`
foreground. Mirrors the Qwen Code reference layout. Side-by-side
mode vertically centers the box against the logo for a balanced
appearance.

### Prompt input is a rounded box

The input area is a full rounded border (top + side + bottom) with
horizontal padding via lipgloss. Border color is `#6c7086`
(Catppuccin overlay1) — visible but muted so it doesn't compete
with content above.

**Width math:** `box.Width(p.width - 2)` reserves 2 cols for the
left + right border characters. `ti.Width = w - 4` reserves an
additional 2 cols for the padding. Get this right or the textinput
overflows.

### Notification box uses warning-colored border

Boot notices ("running in home dir", "no bundle detected") are
`lipgloss.RoundedBorder()` with `theme.Warning` (yellow) foreground.
The yellow border marks the box as a notice; the body text inside
inherits terminal default fg (per the color rule). Light enough to
be guidance, not an error.

Location: `packages/tui/internal/components/notification.go`.

### Status line has NO background fill

Status line uses `theme.Dim` foreground only — no background. The
previous design used `Background(theme.Background)` plus
`Width(s.width)` which filled the row with a "dark" hex that
rendered as a bright/light strip on terminals where palette mapping
inverts dark hexes. Letting the terminal background show through
keeps the status line ambient instead of visually-loud chrome.

Location: `packages/tui/internal/components/statusline.go:View`.

---

## Conversational flow

### Turn separator: full-width, ambient

`turnSeparator(theme, width)` renders `─` repeated for the full
terminal width with `theme.Border` (dimmer than `theme.Dim`). Reads
as a page-break, not as content.

**Don't add text** — previous design rendered `─ turn complete` /
`─ turn complete (max_tokens)` which was system chatter on every
end_turn. Now: pure separator on routine end_turn; a small `⚠ <reason>`
italic-dim line *only* when the model hits a non-routine finish
reason (max_tokens, etc.). The user shouldn't see "complete"
chatter at the end of every successful turn.

Location: `packages/tui/internal/app/app.go:turnSeparator` + the
`turn_complete` case in `handleEvent`.

### No "Tool starting..." lines

The `tool_use_start` event used to emit `"→ <Tool> starting..."`
into the transcript. **Don't.** The subsequent `tool_result` event
prints the full tool card (header + output) — the only visible
artifact the user needs.

`tool_use_start` should still:
- Call `clearThinkingIfPending()` (kills the spinner)
- Commit any in-flight streaming card via
  `if rendered, ok := m.live.EndAssistantCard(); ok { m.print(rendered) }`

But emit nothing visible itself.

Location: `tool_use_start` case in `handleEvent`.

### Tool cards: compact by default, detailed by opt-in (2026-05-22)

The `tool_result` handler in `app.go` branches on
`m.toolOutputMode` (set at boot from
`userSettings.ui.toolOutput.mode`, forwarded via the
`--tool-output-mode` launcher flag). Two modes:

**`compact` (default)** — emits a single line per `tool_result` via
`components.FormatCompactToolLine(tool, input, output, theme, width)`.
Mirrors the Claude mobile app:

```
Read README.md                       ›
Edited app.go +11 -7                 ›
Ran $ bun run test                   ›
⚠ Edit blocked.go                    ›   ← permission denied / cancelled
✗ Bash $ git push                    ›   ← runtime error envelope
```

The trailing `›` chevron (theme.Dim) is a pure visual cue — there's
no interactive expand affordance (scrollback is immutable). Users
re-render the full raw payload via `/expand N` (positional from
most-recent), unchanged from the round-5 ring-buffer model.

Verb mapping owned in
`packages/tui/internal/components/compactline.go`. Adding a new
wire-tool name to the table is a 3-line patch — add a switch case
in `verbAndTarget` plus a test in `compactline_test.go`. MCP tools
auto-handle via the `mcp__<server>__<tool>` naming convention.

Status glyphs:
- `⚠` (`theme.Warning`, yellow, bold) — permission denied / cancelled.
  Detection: Output decodes to bare-text starting with "permission
  denied" (the `src/core/orchestrator.ts` deny branch emits this
  shape).
- `✗` (`theme.Error`, red, bold) — runtime tool error.
  Detection: Output parses as `{status:'error', ...}` envelope.

**`detailed` (opt-in)** — preserves the bordered `ToolCard` from
the round-5 design, but the output is ALWAYS truncated to
`ui.toolOutput.inlineLines` (default 10) with a dim italic
`…[+N more lines]` footer. Set `inlineLines: 0` to collapse the
card to header-only. The `DiffView` path is unaffected — diffs
already render compactly.

**`-v / --verbose` flag** — orthogonal escape hatch, NOT a third
mode. When set, the launcher forwards `--verbose-raw` and the Go
handler appends the raw untruncated Output below either mode's
rendering, styled dim italic.

If the input shape of the wire `ToolResult` event ever needs to
distinguish `permission_denied` more explicitly (the bare-text
detection is brittle if a tool author writes a deny-shaped error
message), the future-proofing path documented in
`docs/specs/2026-05-22-tui-tool-call-abstraction-design.md`'s
"Out of scope" section is to add explicit `isError bool` /
`isDenied bool` fields to the SSE envelope. Punted until/unless
the heuristic proves wrong.

Spec:
`docs/specs/2026-05-22-tui-tool-call-abstraction-design.md`.

### Thinking spinner: live, gen-tracked, self-stopping

The thinking spinner lives in `LiveRegion` (round 5). `startSpinner`
sets the frame via `m.live.SetSpinner(...)` + schedules recurring
`spinnerTickMsg` ticks. Each tick advances the spinner frame and
calls `m.live.SetSpinner` again. The recurring chain stops when:

- `gen != spinnerGen` (stale tick — invalidated by a newer spinner or by `clearThinkingIfPending`)
- `!thinkingPending` (response started arriving)

`clearThinkingIfPending()` calls `m.live.ClearSpinner()`, clears
`thinkingPending`, bumps `spinnerGen`. New spinners (skill expansion
after the initial spinner) also bump `spinnerGen` so old ticks drop.

This pattern is **load-bearing** — without the gen check, multiple
overlapping spinners would race and one would never stop.

---

## Inline styling

### File references auto-wrap in backticks

`wrapFileRefs(text)` runs before glamour. It detects file-path-shaped
tokens and wraps them in backticks so the inline `Code` style (light
sky-blue bold, `#7dd3fc`) applies. Two-pass:

1. **Bullet-aware:** If a line is `- foo bar.png` (or `*`/`+`) and
   the content ends in a recognized extension, the **entire bullet
   content** gets wrapped — including internal spaces. Handles
   multi-word filenames like `Babyboard logo circulat.png`.

2. **Token-level:** For non-bullet lines, run `fileRefPattern` (a
   regex) to wrap individual tokens — paths starting with `/`, `~/`,
   `./`, `../`, or bare filenames ending in a recognized extension.

Both passes skip:
- Content inside existing backtick spans (no double-wrap).
- Content inside fenced ``` code blocks (preserve verbatim).

Extension list lives in `fileRefPattern` and `fileExtensionTailPattern`
(in markdown.go). Add to both if you need new extensions. Don't add
extensions that look like dotted words (`.com`, `.org`) — they'd
match URL fragments and false-match prose.

Location: `packages/tui/internal/render/markdown.go`. 17 unit tests
in `markdown_test.go` pin the boundaries.

### Inline code = light sky-blue bold, no background

`Code` style uses `#7dd3fc` (Tailwind sky-300) + Bold, **no
BackgroundColor**. The previous design had
`BackgroundColor: &codeBg` (Catppuccin mantle `#181825`) which on
terminals with non-standard palette mapping rendered as a near-white
strip — exactly the inverse of what the theme intended.

Color hex (`#7dd3fc`) is fixed, not derived from theme.Primary,
because `theme.Primary`'s `#89b4fa` rendered too dark/saturated on
the user's terminal palette. Sky-300 survives more palette mappings
without losing the "this is code" recognizability.

Same rule applies to `CodeBlock.Background` (fenced code blocks) —
dropped the BackgroundColor for the same reason. Chroma
syntax-highlight colors provide visual identity instead.

### User-line marker uses `❯` + Brand.AccentColor bold

User input echoes render as `❯ <text>` where the marker is
`Brand.AccentColor` (sky-300 `#7dd3fc`) bold, and the body has no
Foreground set (inherits terminal default — bright).

The marker color + bold weight is the user/assistant distinction.
The body matches the brightness of the assistant text and the
typing cursor.

Location: `Model.printUser` (`packages/tui/internal/app/app.go`).

### Hint line below prompt: dim italic

`HintLine("? for shortcuts", theme)` renders the small affordance
line under the prompt. Uses `theme.Dim` italic. Empty hints return
`""` so the caller can render unconditionally.

---

## Slash-command surfaces

### Slash autocomplete popup — drops below input (M11.5 polish)

The autocomplete popup that appears when the prompt starts with `/`
renders **below** the input box, not above. Standard dropdown-suggestion
pattern — users expect typed input → suggestions appearing under it.
Pre-fix the popup rendered above the input, which read as a separate
panel instead of a suggestion attached to what the user was typing.

**Layout integration in `View()`:**

```go
prompt := m.prompt.View()
if m.autocomplete.Visible() {
    prompt = prompt + "\n" + m.autocomplete.View(m.width)
}
```

The popup is part of the "prompt" string region, not the transcript.
The mouse-click region math in `handleMouseClick` puts the popup at
`[transcriptH + promptH, transcriptH + promptH + popupH)`. If you
move the popup back above the input, update that calculation too.

### Enter selects + submits; Tab fills only (M11.5 polish)

When the autocomplete popup is visible:

- **Enter** — fills the highlighted completion AND submits in one
  keystroke. Falls through to the regular Enter submit handler after
  populating the prompt. Hint text reflects this as the primary action.
- **Tab** — fills the completion + trailing space, dismisses the popup,
  leaves the prompt for the user to type args. Useful for arg-taking
  commands like `/skills install <name>`.
- **↑/↓** — navigate.
- **Esc** — dismiss.

**Critical guard: don't clobber typed args.** Only replace the prompt
with the completion when the user hasn't started typing args yet —
specifically, when `strings.TrimPrefix(promptText, "/")` contains no
whitespace. Once args are present (e.g., `/skills reload`), Enter
submits the typed text verbatim. The popup may still be visible
because its filter logic just checks for a leading `/`, not whether
args have been typed; the no-args guard is what makes the UX correct.

Without the guard, `TestApp_SlashSkillsReloadWithServerFetchesSkills`
times out — the test sends `/skills reload` + Enter, expects the
reload to fire, but a destructive Enter handler would submit just
`/skills` and the test would never see the reload request.

**Hint text:** `"Press Enter to select · Esc to cancel"`. Lives in
`packages/tui/internal/components/slashautocomplete.go:View`. Tab is
intentionally not advertised — it's a power-user path for arg-taking
commands; advertising it crowds the hint and confuses new users.

### Static-entries list is hand-mirrored from the TS registry

`packages/tui/internal/components/slashautocomplete.go:staticEntries`
is a compile-time list of slash-command names + one-line descriptions.
It must mirror the TS `COMMAND_REGISTRY` in `src/commands/registry.ts`
because the popup is purely a discovery affordance — the dispatch
itself routes through the M10.5 `POST /sessions/:id/commands` route,
which reads the TS registry directly.

**Drift hazard:** adding a TS-side command without adding a mirror
entry means users can't discover it via the popup, even though it
works when typed directly. Backlog item #45 plans a discovery
endpoint that would eliminate the hand-mirror entirely.

**When adding a new slash command:**
1. Add it to the TS registry (`src/commands/registry.ts` or one of
   the `*_OPS_COMMANDS` arrays).
2. Add a mirror entry to `staticEntries`. Keep the description short,
   verb-first, lowercase, no trailing period — matches existing style.
3. The entry will appear in the popup at the next `sov` boot. No
   special cache invalidation; the list is compile-time.

### Inline PickerCard — dropdown for `pickerOpen` side-effect (M11.5)

When the server emits a `pickerOpen` side-effect on a slash-command
response (`/model`, `/resume`, `/export` no-args), the TUI renders
an inline card matching the Claude Code reference UX (`~/Desktop/goodux.png`).

**Layout integration in `View()`** (round 5):

```go
b.WriteString(m.live.View())          // streaming card + spinner
if m.stallBadge != nil { ... }
if m.picker != nil {
    b.WriteString(m.picker.View(m.width))  // above the prompt
    b.WriteString("\n")
}
b.WriteString("\n" + prompt + "\n")
```

The card renders **between** the live region and the prompt (above
the input box). Unlike the autocomplete popup, the picker is a
modal-like affordance that owns the user's attention until they pick
or cancel.

**Visual conventions** mirror `slashautocomplete.go`:
- Title: bold, no Foreground (terminal default fg renders bright).
- Subtitle: dim italic. Optional — only when payload has one.
- Selected row: `›` prefix + bold, no Foreground (default fg pops
  against the pale-orange neighbour rows).
- Unselected rows: pale orange (`#fab387` — same `slashCommandColor`
  used by the autocomplete popup) for visual consistency.
- Hint: dim text on the row, separated by two spaces from the label.
- Footer: italic grey-blue (`#7a8eb8` — same as the autocomplete
  hint color), reads as ambient guidance. Always shows
  `"↑/↓ navigate · enter confirm · esc cancel"`.
- Box: `theme.CardBorderStyle().Padding(0, 1).Width(width - 2)`.
- Narrow-terminal fallback: when `width < 6`, drop the box and
  render the inner body bare (same as the autocomplete popup).

**Input lock** — while `m.picker != nil`, the input handler routes
↑/↓/Enter/Esc to the picker and absorbs all other keys. Mirrors the
permission-modal pattern. Other inline surfaces (autocomplete popup,
diff focus) should not be active simultaneously; the dispatcher
response that opens the picker arrives after the user has submitted
their slash command, so there's no overlap in practice.

**Resolution model — stateless server (ADR M11.5-03):** on Enter,
the TUI dispatches `/<command> <selected.value>` as a fresh M10.5
call. Server holds no suspended-command state. The arg-form of every
picker command already works — the card just collects the arg
interactively.

**Adding a new picker-driven command:**
1. Add a `requestPicker` branch to the command handler in
   `src/commands/`, before the legacy `pick()` fallback:
   ```ts
   if (ctx.requestPicker) {
     ctx.requestPicker({
       title, subtitle, items, initial,
       onSelect: { command: 'your-command' },
     });
     return '';
   }
   ```
2. Ensure the explicit-arg form (`/your-command <value>`) works — the
   picker's resolution dispatches that.
3. The TUI side needs no changes; `PickerCard` handles any
   `pickerOpen` payload.

Location: `packages/tui/internal/components/pickercard.go` (component),
`packages/tui/internal/app/app.go` (dispatch handling + key routing).

---

## Iteration narrative (M11 → M11.18 + formal M11.5)

For posterity — the iteration order matters because some of these
fixes depend on earlier rules being in place.

| Milestone | Theme | Key shift |
|---|---|---|
| **M11** | Default flip | `--ui tui` becomes default; surface resolver; missing-binary fallback to REPL |
| **M11.1** | Splash + initial colors | Add SOV logo + info card to TUI; initial body-color attempts |
| **M11.2** | Thinking spinner | Brand-color gradient spinner with gen-tracked tick chain |
| **M11.3** | Boxed card + notices + flow | Rounded border on info card; notification component; "? for shortcuts" hint; transcript sizes to content |
| **M11.4** | Logo gradient retune | SOV gradient now blue → teal → purple → pink |
| **M11.5–M11.7** | Body text dim attempt (failed) | Tried `#e2e8f0`, `#f1f5f9`, `#ffffff`, ANSI 15, 256-cube 231 — all rendered dim |
| **M11.7 specifically** | TrueColor force (broke things) | `lipgloss.SetColorProfile(TrueColor)` caused tmux to strip sequences; ALL text fell back to terminal default |
| **M11.8–M11.9** | More color attempts (still failed) | Reverted TrueColor force; tried ANSI 15, 256-cube 231 |
| **M11.10** | **The fix** | Stopped setting `Color` on body text entirely — inherit terminal default. See `tui-color-rendering.md`. |
| **M11.11** | Inline code light-blue bold | Dropped Code's dark-hex `BackgroundColor`; switched to `theme.Primary` + Bold (later revised in M11.13) |
| **M11.12** | Tool/separator/file-ref polish | Removed "tool starting..." lines; full-width turn separator; auto-wrap file refs in backticks |
| **M11.13** | Multi-word filenames + better blue | Bullet-aware wrapping for filenames with spaces; inline code color → `#7dd3fc` |
| **M11.14** | Slash autocomplete colors | Pale orange (`#fab387`) for unselected rows, bold + default-fg for selected. Same color story as inline code in M11.10 — accents read against terminal default. |
| **M11.15** | Tab-autocomplete hint | "press Tab to autocomplete" line at popup footer, italic + grey-blue (`#7a8eb8`) — recessive ambient guidance. Replaced in M11.5 (formal) with the Enter-selects hint. |
| **M11.16** | Hint spacing + casing | Blank-line spacer between match list and footer hint; "Press" capitalized. |
| **M11.17** | /skills install entries | `/skills install` and `/skills uninstall` added to `staticEntries`; pattern for new TS-side commands documented. |
| **M11.18** | Static-entries audit | `staticEntries` grew from 4 to 25 entries (band-aid for the hand-mirror drift) — every TS-registered slash command now surfaces in the popup. Backlog #45 plans the discovery-endpoint fix. |
| **M11.5 (formal)** | Inline picker card + popup polish | Half-milestone — see `docs/state/2026-05-19-m11-5.md`. NEW `requestPicker` capability on `CommandContext`; `/model`, `/resume`, `/export` migrated; new Go `PickerCard` component; T8 spacing fix (pre-prompt gap bumped to 2 lines); popup-below-input layout (uxissue1); Enter-selects-with-args-guard (uxissue2); hint text → "Press Enter to select · Esc to cancel". This M11.5 is distinct from the M11.5 commit-tag in `c9faf6b` (the body-text dim attempt) — the formal half-milestone supersedes that namespace usage. |

The **most-skipped diagnostic step** between M11.5 and M11.10 was
verifying what color the user's terminal actually rendered for the
text I was emitting. If you find yourself trying a third "brighter"
hex value to fix a "text looks dim" complaint, stop and check
[`tui-color-rendering.md`](tui-color-rendering.md) — the fix is
almost certainly "remove the Color field entirely."

---

## Quick decision table

| You want to… | Do this |
|---|---|
| Make text "brighter" | Stop setting `Color`; let terminal default render. |
| Use a dark background to highlight an inline element | Don't. Use bold + accent color instead. Dark-hex backgrounds invert on some terminals. |
| Add a permanent banner above the prompt | Don't. Append it into the transcript as boot content so it scrolls away. |
| Indicate a tool ran | Let `tool_result` render. The default compact-mode handler emits `Verb target ›`; detailed mode emits the bordered ToolCard. Don't emit a "starting..." line on `tool_use_start`. |
| Add a new wire tool name to compact-mode formatting | Add a switch case in `compactline.go:verbAndTarget` (verb mapping + target extractor) plus a happy-path test in `compactline_test.go`. |
| Mark a tool result as an error or denied | Compact mode auto-detects: `{status:'error'}` envelope → `✗` (theme.Error); bare-text "permission denied: …" → `⚠` (theme.Warning). Detection lives in `compactline.go:DetectToolStatus`. |
| Mark a turn boundary | Full-width `─` rule via `theme.Border`. No text. |
| Style a file path | Wrap it in backticks; `Code` style picks it up. Or trust `wrapFileRefs` to detect it. |
| Add a new file extension to auto-styling | Add to BOTH `fileRefPattern` and `fileExtensionTailPattern` in markdown.go. |
| Add a hint below the prompt | `components.HintLine(text, theme)`. Empty string returns empty (no padding). |
| Pick a brand color | Use one of the splash gradient hexes (`#4f8fff`, `#22d3ee`, etc.). Theme-independent. |
| Pick an accent for theme integration | Use `theme.Primary` / `theme.Success` / `theme.Error` / `theme.Warning` / `theme.Dim`. |
| Add a new slash command discoverable in the popup | Mirror it into `slashautocomplete.go:staticEntries` with a short verb-first description. Future fix: backlog #45 (discovery endpoint). |
| Add a new picker-driven slash command | Add a `ctx.requestPicker(...)` branch before the legacy `pick()` fallback. The TUI's `PickerCard` handles any payload. |

## See also

- [`tui-color-rendering.md`](tui-color-rendering.md) — color rendering
  rule (body text inherits terminal default).
- `packages/tui/internal/components/splash.go` — SOV logo + info card
  rendering, gradient definition.
- `packages/tui/internal/components/spinner.go` — thinking spinner +
  gen-tracked tick chain.
- `packages/tui/internal/components/liveregion.go` (round 5) — bottom
  live region: streaming assistant card + spinner + "…running"
  indicator. Replaces the viewport-based transcript for in-View content.
- `packages/tui/internal/components/transcript.go` — DEAD production
  code retained for tests during the round-5 migration; the viewport
  is unused. Slated for retirement in backlog item #47.
- `packages/tui/internal/components/prompt.go` — rounded-border input
  box.
- `packages/tui/internal/components/statusline.go` — bottom metadata
  row (no background fill).
- `packages/tui/internal/components/notification.go` — boot-notice box
  (yellow border, body inherits terminal default).
- `packages/tui/internal/components/slashautocomplete.go` — autocomplete
  popup (drops below input, Enter selects, Tab fills, hand-mirrored
  `staticEntries`).
- `packages/tui/internal/components/pickercard.go` — inline picker card
  rendered from `pickerOpen` side-effects.
- `packages/tui/internal/components/compactline.go` (2026-05-22) —
  `FormatCompactToolLine` for the default compact tool-call rendering.
  Verb table + per-tool input/output extractors + status detection
  (`DetectToolStatus`).
- `packages/tui/internal/components/toolcard.go` — bordered card
  (detailed mode). Now respects an optional `InlineLines` truncation
  cap with a dim `…[+N more lines]` footer.
- `packages/tui/internal/render/markdown.go` — glamour StyleConfig +
  `wrapFileRefs` pre-processor.
- `packages/tui/internal/app/app.go` — turn separator, tool event
  handlers, splash dispatch, picker key handling.
- `docs/specs/2026-05-19-phase-16-1-m11-5-inline-picker-card-design.md`
  — full spec for the formal M11.5 picker work, including the
  `requestPicker` capability and the side-effect protocol.
