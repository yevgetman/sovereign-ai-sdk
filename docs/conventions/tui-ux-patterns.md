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

---

## Layout & flow

### Transcript sizes to content, not to viewport

The transcript viewport sizes itself to `min(content_height, maxHeight)`
on every append. On a fresh session with only the splash + a few
lines, the prompt floats right below the splash content instead of
being anchored at the bottom of the terminal. As content accumulates,
the transcript grows; once it hits `maxHeight` it pins and starts
scrolling.

Mirrors the Qwen Code reference layout. The Bubble Tea convention is
to fill the viewport — we explicitly don't do that.

**Implementation:** `Transcript.SetSize(w, maxHeight)` treats height
as a cap. `Transcript.rebuildHeight()` recomputes the actual height
after every append/update/remove. **All transcript mutation paths
must call `rebuildHeight()`** — `AppendLine`, `AppendAssistantDelta`,
`AppendLiveLine`, `UpdateLiveLine`, `RemoveLastLine`, `SetTheme`,
`ToggleCardExpanded`.

The maxHeight calculation in `app.go`'s `WindowSizeMsg` handler is:

```
maxTranscriptH = msg.Height - statusH - promptH - hintH - spacerH
```

Where:
- `statusH = 1` (status line)
- `promptH = 3` (rounded-border box adds top + bottom)
- `hintH = 1` ("? for shortcuts" line)
- `spacerH = 1` (blank line above prompt)

If you add another row of chrome (e.g., a permanent badge above the
prompt), subtract its height here too.

### Splash + boot notices appear ONCE; they scroll away

The SOV splash logo, info card, tips line, and boot notices ("running
in $HOME", "no bundle detected") are **transcript content**, not
rendered in `View()` every frame. They're appended on the first
`WindowSizeMsg` and scroll up as new content arrives.

**Why this matters:** Permanent chrome that sits above the prompt
all session reads as "always-true UI state" — fine for the splash for
the first 30 seconds, but quickly stale. Boot notices are one-time
guidance ("hey, you're in $HOME"), not permanent flags. Making them
transcript content lets them disappear naturally.

**Guard:** Splash is gated on `!m.splashShown && m.baseURL != ""`.
- `splashShown` prevents re-rendering on subsequent `WindowSizeMsg`
  (terminal resize).
- `baseURL != ""` skips splash in render-only unit tests that use
  empty baseURL — those tests assert specific Y-coordinates for mouse
  clicks and assume no splash content.

### Spacers, not absolute positioning

`View()` returns a single string that Bubble Tea writes top-to-bottom.
Use `"\n"` spacers between logical sections instead of trying to
position elements absolutely. Current order:

```
transcript.View() + "\n"
[stallBadge.View() + "\n"]
"\n" + prompt + "\n"
[hint + "\n"]
statusLine.View()
```

Notices used to render between transcript and prompt; they were moved
into the transcript in M11.6 because anchoring them above the prompt
made them permanent.

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
renders the full tool card (header + output), which is the only
visible artifact the user needs. The "starting" line was redundant
chrome — same information as the card's header, but without the
result content.

`tool_use_start` should still:
- Call `clearThinkingIfPending()` (kills the spinner)
- Call `transcript.EndAssistantCard()` (finalizes any streaming text)

But emit nothing visible.

Location: `tool_use_start` case in `handleEvent` (around app.go:781).

### Thinking spinner: live, gen-tracked, self-stopping

The thinking spinner is appended via `AppendLiveLine` (returns the
line index), then advanced by recurring `spinnerTickMsg` ticks. The
recurring chain stops when:

- `spinnerLineIdx < 0` (line was removed), OR
- `!thinkingPending` (response started arriving), OR
- `gen != spinnerGen` (stale tick from a previous spinner)

`clearThinkingIfPending()` bumps `spinnerGen` and clears
`thinkingPending`, which invalidates any in-flight tick. New
spinners (e.g., skill expansion right after a thinking spinner)
also bump `spinnerGen`, so old ticks drop.

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

### User-line marker uses `»` + theme.Primary bold

User input echoes render as `» <text>` where the marker is
`theme.Primary` (blue) bold, and the body has no Foreground set
(inherits terminal default — bright).

The marker color + bold weight is the user/assistant distinction.
The body matches the brightness of the assistant text and the
typing cursor.

Location: `Transcript.AppendUserLine`.

### Hint line below prompt: dim italic

`HintLine("? for shortcuts", theme)` renders the small affordance
line under the prompt. Uses `theme.Dim` italic. Empty hints return
`""` so the caller can render unconditionally.

---

## Iteration narrative (M11 → M11.13)

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
| Indicate a tool ran | Let `tool_result` render the card. Don't emit a "starting..." line. |
| Mark a turn boundary | Full-width `─` rule via `theme.Border`. No text. |
| Style a file path | Wrap it in backticks; `Code` style picks it up. Or trust `wrapFileRefs` to detect it. |
| Add a new file extension to auto-styling | Add to BOTH `fileRefPattern` and `fileExtensionTailPattern` in markdown.go. |
| Add a hint below the prompt | `components.HintLine(text, theme)`. Empty string returns empty (no padding). |
| Pick a brand color | Use one of the splash gradient hexes (`#4f8fff`, `#22d3ee`, etc.). Theme-independent. |
| Pick an accent for theme integration | Use `theme.Primary` / `theme.Success` / `theme.Error` / `theme.Warning` / `theme.Dim`. |

## See also

- [`tui-color-rendering.md`](tui-color-rendering.md) — color rendering
  rule (body text inherits terminal default).
- `packages/tui/internal/components/splash.go` — SOV logo + info card
  rendering, gradient definition.
- `packages/tui/internal/components/spinner.go` — thinking spinner +
  gen-tracked tick chain.
- `packages/tui/internal/components/transcript.go` — append/update
  primitives, size-to-content logic.
- `packages/tui/internal/components/prompt.go` — rounded-border input
  box.
- `packages/tui/internal/components/statusline.go` — bottom metadata
  row (no background fill).
- `packages/tui/internal/components/notification.go` — boot-notice box
  (yellow border, body inherits terminal default).
- `packages/tui/internal/render/markdown.go` — glamour StyleConfig +
  `wrapFileRefs` pre-processor.
- `packages/tui/internal/app/app.go` — turn separator, tool event
  handlers, splash dispatch.
