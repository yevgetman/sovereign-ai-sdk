# TUI Style Guide Design Spec

**Date:** 2026-05-25
**Status:** Active
**Scope:** New `packages/tui/internal/style/` package; migration of all hardcoded spacing/layout/typography/glyph/brand-color values from 17+ component files into a single authoritative style guide

## Problem

The TUI has ~90 `lipgloss.NewStyle()` call sites across 17+ component files, each with hardcoded spacing, padding, margin, border, glyph, and brand-color values. The Theme system centralizes *colors* well, but layout values are scattered — making UX updates ad-hoc and error-prone.

## Architecture

Two orthogonal concerns, cleanly separated:

| Concern | Package | Mutability | Changed by |
|---------|---------|-----------|------------|
| **Style Guide** | `packages/tui/internal/style/` | Immutable (code-only) | Code change + rebuild |
| **Theme** | `packages/tui/internal/theme/` (existing) | Configurable | `config.json` or TOML file |

The style guide is a package-level exported struct `S`. Components import `style` and reference tokens directly — no constructor injection, no runtime resolution.

```
┌──────────────────────────────────────────────────┐
│                   Component                       │
│                                                   │
│  layout/spacing ──→ style.S  (immutable, global) │
│  colors         ──→ theme.T  (switchable)         │
│                                                   │
│  Composed at render time:                         │
│  lipgloss.NewStyle().                             │
│    Padding(style.S.Card.PaddingV, style.S.Card.PaddingH).│
│    Border(style.S.Card.Border).                   │
│    BorderForeground(theme.Border)                 │
└──────────────────────────────────────────────────┘
```

The style guide determines *structure*. The theme determines *color*. They compose at render time.

## Semantic Groups

Organized by visual context, seeded with exact current values for byte-identical output.

### Card — bordered box pattern (6+ components)

| Token | Value | Used by |
|-------|-------|---------|
| `PaddingV` | `0` | toolcard, pickercard, inputcard, autocomplete, notification, prompt |
| `PaddingH` | `1` | same |
| `BorderOverhead` | `2` | width calculation (left + right border) |
| `Border` | `lipgloss.RoundedBorder()` | all card components |
| `GenerousPaddingV` | `1` | splash info card, goodbye card |
| `GenerousPaddingH` | `2` | same |

### CompactLine — one-liner tool output

| Token | Value | Notes |
|-------|-------|-------|
| `Indent` | `"  "` | 2-space left margin |
| `Chevron` | `"›"` | trailing affordance |
| `PreviewMaxUnknown` | `40` | truncation for unknown tool input |
| `PreviewMaxMCP` | `32` | truncation for MCP tool targets |
| `URLMax` | `60` | URL truncation limit |

### Delegator — routing event lines

| Token | Value | Notes |
|-------|-------|-------|
| `Indent` | `"  "` | matches CompactLine indent |

### Spinner — thinking indicator

| Token | Value | Notes |
|-------|-------|-------|
| `DotCycleStride` | `5` | frames between dot-count changes (~400ms/step) |
| `ColorCycleStride` | `3` | frames per gradient color advance |
| `GlyphSpacing` | `"  "` | gap between glyph and label |

### Prompt — text input box

| Token | Value | Notes |
|-------|-------|-------|
| `MaxHeight` | `8` | max visible textarea rows |
| `PasteAbstractMinLines` | `2` | threshold for paste abstraction |
| `PasteAbstractMinChars` | `200` | secondary paste threshold |
| `BoxOverhead` | `4` | border (2) + padding (2) |
| `PromptWidth` | `2` | "› " prefix width |

### Splash — boot screen

| Token | Value | Notes |
|-------|-------|-------|
| `Gutter` | `2` | space between logo and info card |
| `SafetyMargin` | `2` | minimum margin for fallback mode |

### Goodbye — session end card

| Token | Value | Notes |
|-------|-------|-------|
| `WidthNumerator` | `3` | cardWidth = width × 3/5 |
| `WidthDenominator` | `5` | |
| `LabelPad` | `11` | label column width |
| `AgentPad` | `18` | agent name column width |

### StatusLine — bottom bar

| Token | Value | Notes |
|-------|-------|-------|
| `FieldSeparator` | `"  "` | between fields |
| `EdgeMargin` | `" "` | left/right edge padding |

### Picker — picker card

| Token | Value | Notes |
|-------|-------|-------|
| `ValueGap` | `3` | columns between label and value |
| `SelectedPrefix` | `"› "` | selected row prefix |
| `UnselectedPrefix` | `"  "` | unselected row prefix |

### Permission — permission prompt

| Token | Value | Notes |
|-------|-------|-------|
| `PreviewMax` | `60` | max preview chars before truncation |
| `PaddingH` | `2` | horizontal padding (differs from Card) |
| `LabelWidth` | `7` | "tool   " / "input  " / "reason " |

### Echo — user echo marker

| Token | Value | Notes |
|-------|-------|-------|
| `Marker` | `"» "` | 2-char prefix |
| `MarkerWidth` | `2` | numeric width for wrap calculation |

### Separator — turn separator

| Token | Value | Notes |
|-------|-------|-------|
| `Char` | `"─"` | horizontal rule character |

### Markdown — markdown rendering

| Token | Value | Notes |
|-------|-------|-------|
| `ListLevelIndent` | `4` | indent per nesting level |
| `BlockquoteIndent` | `1` | blockquote indent |
| `ListIndent` | `2` | list item indent |
| `IndentToken` | `"│ "` | blockquote marker |
| `Bullet` | `"•"` | list bullet character |
| `HorizontalRule` | `"────────"` | 8-dash rule |
| `TickedCheckbox` | `"[✓] "` | |
| `UntickedCheckbox` | `"[ ] "` | |
| `H1Prefix` | `"# "` | |
| `H2Prefix` | `"## "` | |
| `H3Prefix` | `"### "` | |
| `H4Prefix` | `"#### "` | |
| `H5Prefix` | `"##### "` | |
| `H6Prefix` | `"###### "` | |

### Diff — diff rendering

| Token | Value | Notes |
|-------|-------|-------|
| `AddedPrefix` | `"+ "` | |
| `RemovedPrefix` | `"- "` | |
| `ContextPrefix` | `"  "` | |
| `HunkMarker` | `"▶ "` | |

### Glyph — shared status indicators

| Token | Value | Notes |
|-------|-------|-------|
| `Success` | `"✓"` | tool success, atom success |
| `Error` | `"✗"` | tool error, atom failure |
| `Warning` | `"⚠"` | permission denied, stall badge |
| `Plan` | `"◇"` | delegator plan start |
| `Done` | `"◆"` | delegator complete |
| `Arrow` | `"→"` | atom dispatch |

### Brand — fixed colors (theme-independent)

| Token | Value | Notes |
|-------|-------|-------|
| `VerbColor` | `"#a78bfa"` | purple for tool verbs + tool card header |
| `AccentColor` | `"#7dd3fc"` | sky-300 for delegator accents |
| `InlineCodeColor` | `"#7dd3fc"` | sky-300 for inline code |
| `HeadingColor` | `"#e0f2fe"` | sky-100 for markdown headings (lighter than sky-300 emphasis) |
| `PickerItemColor` | `"#fab387"` | peach for picker/autocomplete items |
| `PickerHintColor` | `"#7a8eb8"` | grey-blue for hints |
| `PickerBadgeColor` | `"#a6e3a1"` | green for "live" badge |
| `PromptBorderColor` | `"#6c7086"` | Catppuccin overlay1 for prompt border |
| `PermissionYellow` | `"#e5c07b"` | permission prompt yellow |
| `PermissionGrey` | `"#6e7681"` | permission prompt grey |
| `LogoGradient` | `[6]string{...}` | splash gradient (blue→teal→purple→pink) |
| `SpinnerGradient` | `[4]string{...}` | compressed 4-anchor version |

### Typography — text style presets

| Token | Value | Notes |
|-------|-------|-------|
| `TitleBold` | `true` | titles: Bold, no Foreground |
| `HintItalic` | `true` | hints: Italic, uses theme.Dim |
| `SelectedBold` | `true` | selected items: Bold, no Foreground |
| `LinkUnderline` | `true` | links: Underline + Bold |

## Package Layout

```
packages/tui/internal/style/
├── style.go          // StyleGuide struct + var S
├── card.go           // CardStyle
├── compactline.go    // CompactLineStyle
├── delegator.go      // DelegatorStyle
├── spinner.go        // SpinnerStyle
├── prompt.go         // PromptStyle
├── splash.go         // SplashStyle
├── goodbye.go        // GoodbyeStyle
├── statusline.go     // StatusLineStyle
├── picker.go         // PickerStyle
├── permission.go     // PermissionStyle
├── echo.go           // EchoStyle
├── separator.go      // SeparatorStyle
├── markdown.go       // MarkdownStyle
├── diff.go           // DiffStyle
├── glyph.go          // GlyphTokens
├── brand.go          // BrandColors
├── typography.go     // TypographyStyle
└── style_test.go     // Non-zero, snapshot, immutability tests
```

## Call-Site Migration

Before:
```go
const CompactLineLeftMargin = "  "
const CompactLineVerbColor = "#a78bfa"
func FormatCompactToolLine(...) string {
    return CompactLineLeftMargin + verb + " " + target
}
```

After:
```go
import "sovereign-ai-harness/packages/tui/internal/style"
func FormatCompactToolLine(...) string {
    return style.S.CompactLine.Indent + verb + " " + target
}
```

## Testing Strategy

1. **Non-zero test** — every field in every sub-struct must be non-zero (catches forgotten initialization)
2. **Known-values snapshot** — asserts exact current values for every token (catches unintended drift)
3. **Immutability guard** — `style.S` at init equals `style.S` after simulated render (confirms no mutation)

## What Changes

- New `packages/tui/internal/style/` package (~18 files)
- Every component file migrates inline constants → `style.S.*` references
- Per-component `const`/`var` declarations for spacing/layout/glyphs deleted
- Markdown renderer wires glamour config from `style.S.Markdown.*`

## What Does NOT Change

- Theme system (untouched)
- Component constructors (no new parameters)
- Visual output (byte-identical — seeded with exact current values)
- Transport layer (data-only)

## Future Benefits

- UX updates are single-line changes in the style package
- New components reference the guide by convention
- The guide serves as living documentation of every visual constant
- Spacing consistency enforced by import convention, not code review
