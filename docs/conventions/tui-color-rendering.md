# TUI color rendering — when to set a foreground color, when NOT to

**When to read:** Before adjusting any text color in `packages/tui/`.
Especially before assuming "use a brighter hex" will solve a legibility
complaint — that assumption cost ~6 commits (M11.5 → M11.10) before the
right model emerged.

**Brand-fixed colors** (hex values that don't change with themes) now
live in the style guide at `packages/tui/internal/style/` under
`style.S.Brand.*`. See `docs/specs/2026-05-25-tui-style-guide-design.md`
for the full token inventory.

## The hard rule

**For body text — assistant responses, user-input echoes, notification
content, anything that needs to be the user's primary reading surface —
do NOT set a foreground color.** Let it inherit the terminal default.

For accent colors — headings, links, errors, dim metadata, code
keywords, the user-line `»` marker, anything that needs to be
*distinguishable from body text* rather than just bright — keep using
`theme.Primary` / `theme.Success` / `theme.Error` / `theme.Dim`. Those
ARE different from terminal default, which is the point.

## Why

The terminal's actual color rendering is the composition of three
independently-customizable layers:

1. **What the program emits** — lipgloss / glamour / direct ANSI escapes.
2. **What the multiplexer passes through** — tmux/screen strip or
   quantize sequences based on their own profile.
3. **What the terminal maps to pixels** — every terminal has a
   user-configurable 16-color palette, and some allow customizing the
   256-color extension table too.

A "bright white" value (`#ffffff`, `#cdd6f4`, ANSI `15`, 256-color
`231`) can land on a DIM pixel color in any of these three layers. The
user's terminal palette can map "Bright White" to a muted shade for a
softer aesthetic. tmux without `terminal-overrides ',xterm*:Tc'` strips
truecolor sequences entirely. Forcing TrueColor via
`lipgloss.DefaultRenderer().SetColorProfile(termenv.TrueColor)` makes
that stripping worse, not better.

The terminal default foreground (what bubbles textinput uses when no
style is applied; what the prompt cursor renders in) is the one path
that bypasses all of this. The user has already configured their
terminal so the default foreground is what they want to read against
the default background. Trust it.

## The rule, restated as code

```go
// WRONG — assumes the terminal will render this brightly
body := lipgloss.NewStyle().
    Foreground(lipgloss.Color("#ffffff")).  // may quantize to dim grey in tmux
    Render(text)

// WRONG — assumes ANSI 15 is bright white
body := lipgloss.NewStyle().
    Foreground(lipgloss.Color("15")).  // maps to terminal's user-customizable "Bright White"
    Render(text)

// WRONG — assumes 256-color cube entry 231 is hardware-fixed
body := lipgloss.NewStyle().
    Foreground(lipgloss.Color("231")).  // some terminals customize the 256 palette too
    Render(text)

// CORRECT — terminal default fg renders body text
body := text  // or lipgloss.NewStyle().Render(text) if you need bold/italic
```

For glamour StyleConfig:

```go
// WRONG
Paragraph: ansi.StyleBlock{
    StylePrimitive: ansi.StylePrimitive{
        Color: &fg,  // any "bright" value can render dim
    },
},

// CORRECT
Paragraph: ansi.StyleBlock{
    StylePrimitive: ansi.StylePrimitive{
        // No Color — inherit terminal default foreground.
    },
},
```

## What's still OK to color

Things that need to be **different from body** (so visually distinct,
not just bright) still get explicit colors:

| Element | Color | Why |
|---|---|---|
| `❯` user-line marker | `Brand.AccentColor` (bold) | distinguishes user lines from assistant |
| Headings (H1–H6) | `Brand.HeadingColor` (`#e0f2fe` sky-100, bold) | structural distinction — clearly *lighter* than emphasis (see "Heading vs emphasis hierarchy" below) |
| Links / images | `theme.Primary` | actionable / external reference |
| Inline code | `theme.Success` on `theme.CodeBackground` | code-vs-prose distinction |
| Block quotes | `theme.Dim` | quoted-source signal |
| Horizontal rules | `theme.Dim` | structural separator |
| Errors / diff removed | `theme.Error` | severity signal |
| Diff added | `theme.Success` | severity signal |
| Code comments | `theme.Dim` | de-emphasized in syntax highlighting |
| Status-line metadata | `theme.Dim` | ambient context |
| Splash logo | hex gradient | brand cue (independent of theme) |
| Spinner glyph | hex gradient | brand cue (independent of theme) |
| Boot-notice borders | `theme.Warning` | informational-but-noticeable |

Bold/italic attributes can stand in for color when they're sufficient
to distinguish — e.g., `Emph` (`*italic*`) uses italic only, no Color.
The terminal's bold rendering is typically also brighter than the
regular default.

**Exception (2026-05-28):** `Strong` (`**bold**`) now uses
`Brand.AccentColor` (sky-300, `#7dd3fc`) in addition to bold, matching
inline `Code`. This unifies bold-emphasis treatment — pre-fix, the
model emitting `**56**` (Strong) rendered uncolored while `Node.js`
inside backticks (Code) rendered sky-blue, leading to visually
inconsistent emphasis across the same conceptual "emphasized text"
category. Brand.AccentColor is a fixed hex (not a theme token) so it
survives palette quantization. `GenericStrong` inside syntax-
highlighted code blocks still uses bold-only because it lives inside
a code block with its own styling.

## The iteration loop that produced this rule (M11.5 → M11.10)

For posterity — so the same path doesn't get re-walked:

1. **M11.5** (`c9faf6b`) — bumped assistant body from `#cdd6f4`
   (Catppuccin Mocha text) to `#e2e8f0` (Slate 200). User: "no change."
2. **M11.6** (`a814a0d`) — bumped to `#f1f5f9` (Slate 100) and moved
   notifications into transcript so they scroll. User: "no change."
3. **M11.7** (`d040c0a`) — bumped to `#ffffff` AND forced
   `lipgloss.DefaultRenderer().SetColorProfile(termenv.TrueColor)`.
   User: "**worse than before**." tmux without Tc-override stripped
   the truecolor sequences entirely; text fell back to terminal-default
   AT BEST, often dimmer.
4. **M11.8** (`a5457a0`) — reverted TrueColor force, switched to
   ANSI `15` (the universal "bright white" 16-color code). User: "no
   improvement." Many iTerm/Terminal color schemes (Solarized,
   Gruvbox-soft, etc.) set the "Bright White" palette entry to a dim
   shade like `#cccccc` for a softer aesthetic.
5. **M11.9** (`d18617c`) — switched to 256-color `231`, claimed to be
   palette-fixed at RGB (255,255,255). User: "still dark." Some
   terminals customize the 256-color extension table too; "231 is
   spec-fixed" is true in principle but not in practice.
6. **M11.10** (`444b7f2`) — gave up on picking the "right bright
   color." Removed `Color` from all body-text style fields entirely.
   Body text now inherits the terminal default — same path the
   bubbles textinput uses for the typing cursor. User: **"ok its
   working now."**

The diagnostic clue was visible in the user's M11.9 screenshot:
the text being actively typed in the prompt input was BRIGHT WHITE
while everything I'd styled was dim grey. The textinput component
uses no foreground style and inherits terminal default. That was the
proof — my "bright" colors were ALL rendering dimmer than the
terminal default.

## Follow-on: dark hex backgrounds are also unreliable (M11.11)

Same root cause family. Glamour's inline `Code` style had
`BackgroundColor: &codeBg` where `codeBg = theme.CodeBackground`
(`#181825` Catppuccin mantle — meant to be a *dark* code-block
fill). On terminals where the palette inverts dark hexes, that fill
rendered as a **near-white strip** behind every backtick span — the
exact inverse of what the theme intended.

**Rule:** dark hex backgrounds are as unreliable as bright hex
foregrounds. Drop the `BackgroundColor` field; use bold + accent
color to distinguish inline elements instead. Same fix shipped to
the fenced `CodeBlock.Background` for the same reason.

## Follow-on: even theme.Primary can render too dark (M11.13)

The inline `Code` style picked `theme.Primary` (`#89b4fa` Catppuccin
blue) for the foreground after dropping the background in M11.11.
The user reported it rendered too dark/saturated — they wanted a
clearly lighter sky-blue. Same palette-mapping issue at the
foreground end this time.

**Fix:** for inline code specifically, use a fixed sky-blue hex
(`#7dd3fc` Tailwind sky-300) bound to a local `inlineCodeColor`
variable. Not derived from `theme.Primary` so themes can't drift it
back into a dark range. Headings later joined this fixed-hex family
too (see next section); links and errors still use theme tokens
because they're not "this-must-read-as-a-specific-light-blue"
elements.

**Lesson:** if an accent must read as a *specific shade family*
(light blue, dark green, etc.) rather than just "some accent
color," pin it to a fixed hex outside the theme tokens. Theme
tokens are for thematic consistency; fixed hexes are for
shade-specific identity.

## Heading vs emphasis hierarchy: sky-100 over sky-300

Markdown headings and inline emphasis share the "light sky blue"
family but are pinned to **two fixed hexes one full rung apart** so
they read as distinct structural tiers:

| Element | Token | Hex | Tailwind |
|---|---|---|---|
| Headings H1–H6 | `Brand.HeadingColor` | `#e0f2fe` | sky-100 (clearly lighter) |
| `**bold**` (Strong) + inline `` `code` `` | `Brand.AccentColor` | `#7dd3fc` | sky-300 (darker) |

Headings sit **clearly lighter** than inline emphasis. The evolution:

1. **Pre-`5e2bdc7`** — headings derived from `theme.Primary`
   (Catppuccin `#89b4fa` / Sovereign `#58a6ff`), which the user found
   too dark/saturated for `##` structural markers.
2. **`5e2bdc7` (2026-05-20)** — pinned to sky-200 `#bae6fd`, one step
   lighter than the sky-300 emphasis.
3. **2026-05-29** — sky-200 sat only *one* rung above the sky-300
   emphasis, which read as too subtle (headings and bold/code looked
   nearly the same blue). Moved one more rung lighter to sky-100
   `#e0f2fe` so the heading tier is unmistakable. sky-50 `#f0f9ff` /
   anything paler was rejected — it washes toward white and loses the
   blue identity (and re-enters the bright-white quantization trap that
   the M11.5→M11.10 saga above warns about).

Both are fixed hexes (not theme tokens) so palette quantization can't
collapse the gap — per the shade-specific-identity rule above. Headings
are theme-independent by design; a `## Header` renders byte-identically
under every theme (asserted in `markdown_test.go`).

**Diagnostic — headings rendering the SAME blue as bold/inline-code:**
that means the running `sov-tui` Go binary predates `5e2bdc7` (the
original heading-color pin, 2026-05-20) — i.e. the **Go binary is
stale** even if `sov --version` reports a current TS runtime. The two
go out of sync when an upgrade's postinstall TUI rebuild silently skips
(Go < 1.24 on PATH, or trust not granted). If headings render lighter
than bold/code but the gap looks too small, the binary is merely a
generation behind (sky-200 era, `5e2bdc7`..pre-`2026-05-29`); the
current source is sky-100. Either way the fix is to rebuild the binary
— the source is already correct. See "How to verify a color change
actually shipped" below for the binary-freshness check.

## Rule: no `t.Primary` blue in tool or routing output

`t.Primary` renders as a saturated "basic blue" on most terminal palettes
(the same root-cause family as the body-text brightness problem above).
For tool compact lines and delegator event lines, `t.Primary` is **never
the right choice** for text foreground.

Instead:

| Element family | What to use |
|---|---|
| Compact-line verb ("Read", "Edited", …) | `CompactLineVerbColor` (`#a78bfa`, brand purple) |
| AgentTool verb ("Dispatched") | `DelegatorAccentColor` (`#7dd3fc`, sky-300) |
| Delegator accents (plan header, lane names, atom count) | `DelegatorAccentColor` (`#7dd3fc`, sky-300) |
| Structural text ("atom N on") | `t.Foreground` (terminal default, bright) |
| Detail text (duration, preview, distribution) | `t.Info` (muted but readable) |
| Status glyphs (✓ / ✗) | `t.Success` / `t.Error` (semantic — keep) |

`t.Primary` remains correct for **structural markdown** links
where it serves as an accent against body text (headings use the fixed
`Brand.HeadingColor` sky-200, not `t.Primary` — see the heading hierarchy
section above). The `❯` user marker uses
`Brand.AccentColor` (sky-300, #7dd3fc) for better visibility. It
should not appear in the tool/routing output pipeline. This rule was added
after `t.Primary` blue on the dark Catppuccin Mocha theme rendered
indistinguishably from "basic terminal blue" in the delegator event lines
(v0.6.1 → v0.6.3 iteration, 2026-05-25).

## How to verify a color change actually shipped

The Go binary is rebuilt by `scripts/build-tui.ts` (postinstall) on
every `sov upgrade`. To confirm a change reached the running binary:

```bash
# Check the installed binary's mtime vs. now
ls -la ~/.bun/install/global/node_modules/@yevgetman/sov/bin/sov-tui

# Verify which commit the installed sov reports
sov --version  # prints VERSION-<short-sha>
```

If `sov-tui` mtime is old, postinstall didn't run — either the trust
hasn't been granted (`bun pm -g trust @yevgetman/sov`) or Go ≥ 1.24
isn't on PATH. `sov upgrade` does NOT fail when the postinstall fails;
the TS runtime installs successfully but the TUI binary stays stale.

If the SHA in `sov --version` matches the latest commit but text still
looks wrong, the binary is current and the color choice itself is the
problem (apply the rule at the top of this file).

## See also

- `packages/tui/internal/render/markdown.go` — the glamour StyleConfig
  where this rule was learned in full. Section comments explain
  per-field why some still have Color and some don't.
- `packages/tui/internal/components/transcript.go` — `AppendUserLine`
  applies this rule.
- `packages/tui/internal/components/notification.go` — `Notification`
  applies this rule.
