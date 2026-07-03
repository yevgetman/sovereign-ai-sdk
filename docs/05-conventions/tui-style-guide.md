# TUI style guide — the single source of truth for layout tokens

**When to read:** Before adding or modifying ANY visual element in `packages/tui/` — spacing, padding, margins, borders, glyphs, brand colors, typography, or truncation limits. This is mandatory, not optional.

## The hard rule

**All spacing, padding, margin, border, glyph, brand-color, and typography values in the TUI MUST come from the style guide at `packages/tui/internal/style/style.go`.** Never hardcode a numeric padding, a glyph character, a brand hex, or a truncation limit directly in a component. Reference `style.S.*` instead.

This rule is the layout counterpart of the color-rendering rule in [`tui-color-rendering.md`](tui-color-rendering.md). Together they mean:

- **Layout/structure** → `style.S.*` (immutable, code-only)
- **Theme-switchable colors** → `theme.T` (configurable via `config.json` / TOML)

## What lives in the style guide

The style guide is organized by semantic group. Each group owns the tokens for its visual context:

| Group | What it covers | Example tokens |
|-------|---------------|----------------|
| `Card` | Bordered-box padding, border type, width overhead | `style.S.Card.PaddingH`, `style.S.Card.Border` |
| `CompactLine` | One-liner tool output indent, chevron, truncation | `style.S.CompactLine.Indent`, `style.S.CompactLine.URLMax` |
| `Delegator` | Routing event line indent | `style.S.Delegator.Indent` |
| `Spinner` | Thinking indicator timing, spacing | `style.S.Spinner.DotCycleStride` |
| `Prompt` | Text input box sizing, paste thresholds | `style.S.Prompt.MaxHeight` |
| `Splash` | Boot screen gutter, margins | `style.S.Splash.Gutter` |
| `Goodbye` | Session-end card proportions, column widths | `style.S.Goodbye.LabelPad` |
| `StatusLine` | Bottom bar separators, margins | `style.S.StatusLine.FieldSeparator` |
| `Picker` | Picker card column gap, row prefixes | `style.S.Picker.SelectedPrefix` |
| `Permission` | Permission prompt preview limits, padding | `style.S.Permission.PreviewMax` |
| `Echo` | User echo marker, width | `style.S.Echo.Marker` |
| `Separator` | Turn separator character | `style.S.Separator.Char` |
| `Markdown` | Markdown rendering tokens (bullets, headings, rules) | `style.S.Markdown.Bullet` |
| `Diff` | Diff rendering prefixes | `style.S.Diff.AddedPrefix` |
| `Glyph` | Shared status indicator characters | `style.S.Glyph.Success`, `style.S.Glyph.Error` |
| `Brand` | Fixed hex colors that don't change with themes | `style.S.Brand.VerbColor`, `style.S.Brand.AccentColor` |
| `Typography` | Text style presets (bold/italic/underline flags) | `style.S.Typography.TitleBold` |

## How to use it

### Referencing tokens in a component

```go
import "github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/style"

// Good — references the style guide
box := t.CardBorderStyle().
    Padding(style.S.Card.PaddingV, style.S.Card.PaddingH).
    Width(width - style.S.Card.BorderOverhead)

// Bad — hardcodes values
box := t.CardBorderStyle().Padding(0, 1).Width(width - 2)
```

### Adding a new component

When creating a new TUI component:

1. Check if existing style tokens cover your needs (most components reuse `Card.*` padding).
2. If you need new tokens, add them to the appropriate semantic group in `style.go` — or create a new group if no existing group fits.
3. Add the new tokens to the `TestKnownValues` snapshot test in `style_test.go`.
4. Reference `style.S.*` in your component — never inline the values.

### Changing a visual constant

To update a spacing value, glyph, or brand color:

1. Change the value in `style.go`.
2. Update the corresponding assertion in `TestKnownValues` in `style_test.go`.
3. Run `go test ./internal/style/` to verify.
4. The change automatically propagates to every component that references the token.

## What does NOT belong in the style guide

- **Theme-switchable colors** — those stay in `packages/tui/internal/theme/`. The style guide owns colors that are brand-fixed (same across all themes).
- **Animation frame data** — e.g., the Braille spinner frames. These are animation content, not layout tokens.
- **ASCII art content** — e.g., the SOV logo lines. Content, not tokens.
- **Wire schema types** — those live in `packages/tui/internal/transport/`.

## Companion docs

- [`tui-color-rendering.md`](tui-color-rendering.md) — when to set foreground color, when NOT to.
- [`tui-ux-patterns.md`](tui-ux-patterns.md) — layout flow, component behavior, interaction patterns.
- [`specs/2026-05-25-tui-style-guide-design.md`](specs/2026-05-25-tui-style-guide-design.md) — the original design spec with the full token inventory.
