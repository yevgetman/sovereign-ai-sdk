# Phase 16.1 M9 — Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent model policy: Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; never Haiku (see `docs/05-conventions/subagent-policy.md`).

**Goal:** Take the Phase 16.1 split-process TUI from "wire-correct" (M4–M8) to demo-quality visible polish. Twelve tasks ship two new Go packages (`internal/theme/`, `internal/render/`), wire markdown + syntax highlighting + inline diffs + styled tool/goodbye/compaction cards + slash autocomplete + mouse wheel scroll + a live status line, and close out cleanup items (#29, #39, three inherited `t.Skip`'d tests).

**Architecture:** Visual-polish work concentrated in `packages/tui/` (Go side). One cross-stack thread on the TS side: emit a new `status_update` SSE event from `src/server/routes/turns.ts` at usage-delta points. terminalRepl untouched (Postmortem Rule 1). Per-component constructor injection of theme (no global). Renderers are pure `(text, theme, width) → string` — no `tea.Msg`, no state.

**Tech Stack:** Go 1.24 / Bubble Tea v1.3.10 + lipgloss + bubbles + `glamour` (markdown) + `chroma/v2` (syntax highlight). TS / Bun / Hono on the server side. `bun:test` (TS), `go test` (Go).

**Spec references:**
- `specs/2026-05-16-phase-16-1-m9-visual-polish-design.md` (M9 design — the spec this plan implements)
- `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §10 (M9 milestone row)
- `docs/08-roadmap/backlog/post-phase-13-4.md` items #29 (lipgloss `Style.Copy()`), #39 (Go mirror for `SessionSummaryEvent`)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4
- `plans/2026-05-16-phase-16-1-m8-polish-surfaces.md` (M8 plan — reference pattern)

**Scope guard — what M9 does NOT do:**
- **terminalRepl.ts untouched.** Postmortem Rule 1 — still binding through M11.
- **No TOML theme loader.** Built-in light + dark only; M9.5 owns the loader.
- **No mouse click handling.** Wheel scroll only; click-to-focus and click-to-collapse are M9.5.
- **No M10 parity audit.** That's M10's job. M9 close-out states explicitly that parity is not asserted.
- **No real-Anthropic visual smoke.** Same shape as M7/M8 — separate post-M9 hardening session.
- **No `/review` TUI surface.** Carry-forward from M7.
- **No Bubble Tea v2 migration.** v1.3.10 already has mouse support; upgrade deferred.

---

## Inline Decisions (ADRs M9-01 through M9-12, locked at spec)

| Decision | Resolution | Why |
|---|---|---|
| **M9-01** Theme injection | Constructor injection per-component, no global. | Decouples module-load order; theme swap is a pure re-render. |
| **M9-02** Renderer purity | `internal/render/*` is pure `(text, theme, width) → string`. | Table-driven unit tests, no teatest harness. |
| **M9-03** TOML loader deferred | Built-in light + dark only in M9; TOML in M9.5. | Loader is ~80 LoC but adds config-resolution surface. |
| **M9-04** `status_update` source | Server-pushed SSE event, throttled ~100ms. | Liveness during streaming; client-derived would only update at turn end. |
| **M9-05** Slash autocomplete cache | Fetch at boot; invalidate on `compaction_complete`. | Matches M8 T6 skill-cache pattern. |
| **M9-06** Mouse v1 | Wheel-scroll only. | Click handling needs modal-stack interaction analysis; defer. |
| **M9-07** `/expand` ring buffer | Untouched in M9. Diff view focus is separate state. | Avoid `j`/`k` ambiguity between scroll-expanded vs hunk-nav. |
| **M9-08** Compaction marker | Inline transcript element, not status-line indicator. | Compaction is a discrete in-history moment, not continuous state. |
| **M9-09** Goodbye degradation | Renders M7-shape when M8 extension fields absent. | Forward-compat with older `sov` versions. |
| **M9-10** terminalRepl untouched | All M9 code parallel-additive in `packages/tui/` + `src/server/`. | Postmortem Rule 1. |
| **M9-11** Theme palette | Catppuccin (Mocha dark, Latte light). | Well-known, AA-contrast tested, free-to-use. |
| **M9-12** `/theme` slash | Dedicated `/theme <name>` slash; persists via existing config-set semantics. | Discoverability; falls through to `/config set theme` internally. |

---

## File Structure

### New files

| Path | Responsibility | Approx LoC |
|---|---|---|
| `packages/tui/internal/theme/theme.go` | `Theme` struct (palette + style helpers); `Light()` + `Dark()` constructors; `Resolve(name)` | ~80 |
| `packages/tui/internal/theme/light.go` | Catppuccin Latte palette | ~50 |
| `packages/tui/internal/theme/dark.go` | Catppuccin Mocha palette | ~50 |
| `packages/tui/internal/theme/theme_test.go` | Palette load + Resolve + unknown-name behavior | ~80 |
| `packages/tui/internal/render/markdown.go` | glamour wrapper; `Markdown(text, theme, width) → string` | ~60 |
| `packages/tui/internal/render/code.go` | chroma wrapper; `Code(text, language, theme, width) → string` | ~70 |
| `packages/tui/internal/render/diff.go` | Hunk parser + chroma highlighter; `Diff(text, theme, width) → (Hunks, error)` + `RenderHunks(hunks, activeHunkIdx, theme, width) → string` | ~150 |
| `packages/tui/internal/render/plain.go` | Fallback renderer; `Plain(text, theme, width) → string` | ~40 |
| `packages/tui/internal/render/markdown_test.go` | Markdown rendering shape + fallback on parse error | ~80 |
| `packages/tui/internal/render/code_test.go` | Code highlighting per language + missing-language fallback | ~80 |
| `packages/tui/internal/render/diff_test.go` | Hunk parsing + render with activeHunkIdx + out-of-range clamp | ~120 |
| `packages/tui/internal/render/plain_test.go` | Plain fallback width-wrapping | ~50 |
| `packages/tui/internal/components/slashautocomplete.go` | Popup overlay; fuzzy matcher; key handling | ~180 |
| `packages/tui/internal/components/slashautocomplete_test.go` | Filter behavior + Tab/Esc/Enter dispatch | ~120 |
| `packages/tui/internal/components/goodbye.go` | Styled session-summary card; consumes `SessionSummary` struct | ~150 |
| `packages/tui/internal/components/goodbye_test.go` | Render with full payload + degrade to M7-shape | ~100 |
| `packages/tui/internal/components/diffview.go` | Focused diff view; `j`/`k` cycles `activeHunk`; bounds clamp | ~120 |
| `packages/tui/internal/components/diffview_test.go` | Hunk nav + clamp | ~80 |
| `packages/tui/internal/components/compactioncard.go` | Inline pill renderer for `compaction_complete` events | ~50 |
| `packages/tui/internal/components/compactioncard_test.go` | Render with token deltas | ~60 |
| `packages/tui/internal/app/m9Full_test.go` | T12 — Go Model-level smoke through M9 visible surfaces | ~150 |
| `tests/server/turns.statusUpdate.test.ts` | T10 — TS unit test for status_update emission + throttle | ~150 |
| `tests/server/m9Full.test.ts` | T12 — TS-side integration smoke | ~200 |

### Modified files

| Path | Modification |
|---|---|
| `packages/tui/go.mod` | Add `github.com/charmbracelet/glamour` + `github.com/alecthomas/chroma/v2` |
| `packages/tui/internal/components/transcript.go` | T3 — route assistant text blocks through `render/markdown.go`; T4 — code block highlighting |
| `packages/tui/internal/components/toolcard.go` | T6 — theme-aware redesign; T5 — route FileEdit/FileWrite through diff renderer |
| `packages/tui/internal/components/permission.go` | T11 — replace lipgloss `Style.Copy()` calls with non-deprecated equivalent (#29) |
| `packages/tui/internal/components/prompt.go` | T8 — emit `/`-keystroke signal for autocomplete trigger |
| `packages/tui/internal/components/statusline.go` | T10 — themed; consume status_update events; spinner during streaming |
| `packages/tui/internal/app/app.go` | T1 (theme injection at New + dispatch `/theme`); T7 (goodbye card + compaction marker); T8 (autocomplete routing); T9 (mouse handling) |
| `packages/tui/internal/app/keys.go` | T5 (`j`/`k` bindings for diff focus); T8 (Tab/Esc for autocomplete); T1 (`/theme` command) |
| `packages/tui/internal/app/app_test.go` | T11 — re-enable + fix 3 inherited `t.Skip`'d tests via deterministic event sequencing |
| `packages/tui/internal/transport/types.go` | T7 — add Go mirror struct for `SessionSummaryEvent` with M8 extension fields (closes #39) |
| `src/server/routes/turns.ts` | T10 — emit `status_update` events at usage_delta points, throttled ~100ms; flush on turn_complete |
| `docs/08-roadmap/backlog/post-phase-13-4.md` | T12 — close #29 (lipgloss `Style.Copy()`) and #39 (Go mirror for SessionSummaryEvent) |
| `DECISIONS.md` | T12 — add ADRs M9-01 through M9-12 |
| `docs/07-history/state/2026-05-XX.md` | T12 — new close-out snapshot (supersedes 2026-05-16) |
| `docs/07-history/state/archive/2026-05-16.md` | T12 — archive the M8 close-out snapshot |
| `CLAUDE.md` / `AGENTS.md` | T12 — update state-snapshot pointer; byte-identical mirror preserved |
| `docs/06-testing/testing-log.md` | T12 — append M9 close-out entries |

---

## Files Touched (by task)

| Task | Modifies | Creates | Tests |
|---|---|---|---|
| T1 | `packages/tui/internal/app/app.go`, `keys.go` | `internal/theme/{theme,light,dark}.go` | `internal/theme/theme_test.go` |
| T2 | `packages/tui/go.mod`, `go.sum` | `internal/render/{markdown,code,plain}.go` | `internal/render/{markdown,code,plain}_test.go` |
| T3 | `packages/tui/internal/components/transcript.go` | — | extends `transcript_test.go` (or new test if missing) |
| T4 | `packages/tui/internal/components/transcript.go`, `toolcard.go` | — | extends existing tests |
| T5 | `packages/tui/internal/components/toolcard.go`, `app/app.go`, `app/keys.go` | `internal/render/diff.go`, `internal/components/diffview.go` | `internal/render/diff_test.go`, `internal/components/diffview_test.go` |
| T6 | `packages/tui/internal/components/toolcard.go` | — | extends existing tests |
| T7 | `packages/tui/internal/transport/types.go`, `packages/tui/internal/app/app.go` | `internal/components/goodbye.go`, `internal/components/compactioncard.go` | `goodbye_test.go`, `compactioncard_test.go` |
| T8 | `packages/tui/internal/components/prompt.go`, `app/app.go`, `app/keys.go` | `internal/components/slashautocomplete.go` | `slashautocomplete_test.go` |
| T9 | `packages/tui/internal/app/app.go` | — | extends `app_test.go` |
| T10 | `src/server/routes/turns.ts`, `packages/tui/internal/components/statusline.go` | — | `tests/server/turns.statusUpdate.test.ts`, extends `statusline_test.go` if exists |
| T11 | `packages/tui/internal/components/permission.go`, `packages/tui/internal/app/app_test.go` | — | re-enables 3 skipped tests |
| T12 | `docs/08-roadmap/backlog/post-phase-13-4.md`, `DECISIONS.md`, `CLAUDE.md`, `AGENTS.md`, `docs/06-testing/testing-log.md`, `docs/07-history/state/archive/2026-05-16.md` (move), `docs/07-history/state/2026-05-XX.md` (new) | `tests/server/m9Full.test.ts`, `packages/tui/internal/app/m9Full_test.go` | both new |

---

## Task 1: Theme package foundation

**Goal:** Build `internal/theme/` with `Theme` struct, light + dark palettes (Catppuccin), and the `/theme <name>` slash handler. Constructor injection — no global. Pass theme to existing components via their New(...) constructors and rebuild any retained state. Add `model.theme` field to `app.Model`.

**Files:**
- Create: `packages/tui/internal/theme/theme.go`, `light.go`, `dark.go`, `theme_test.go`
- Modify: `packages/tui/internal/app/app.go` (add `theme` field + `/theme` slash handler), `app/keys.go` (`/theme` keybind)

### Steps

- [ ] **Step 1 — Write `internal/theme/theme.go`**

```go
// Package theme provides constructor-injected color + style palettes for the
// Phase 16.1 TUI. v1 ships two built-in themes (light + dark); a TOML loader
// for user themes is deferred to M9.5 (ADR M9-03).
package theme

import "github.com/charmbracelet/lipgloss"

// Theme is a frozen palette + lipgloss style helpers. Pass by value to
// components via their New(...) constructors. Swap by re-constructing a new
// Theme and dispatching a themeChanged tea.Msg in the app layer.
type Theme struct {
	Name string

	// Surface colors
	Background lipgloss.Color
	Foreground lipgloss.Color
	Dim        lipgloss.Color // muted text (timestamps, separators)
	Border     lipgloss.Color // card borders

	// Semantic accent colors
	Primary lipgloss.Color // user marker, prompt cursor
	Success lipgloss.Color // tool success header, "ok" marker
	Warning lipgloss.Color // permission modal border, stall badge
	Error   lipgloss.Color // turn_error, denied permission
	Info    lipgloss.Color // dim italic system messages

	// Code/diff specifics
	CodeBackground lipgloss.Color
	DiffAdded      lipgloss.Color
	DiffRemoved    lipgloss.Color
	DiffContext    lipgloss.Color
}

// HeaderStyle returns the bold-primary header used at the top of tool cards.
func (t Theme) HeaderStyle() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.Primary).Bold(true)
}

// DimStyle returns the italic-dim style used for system messages
// (thinking placeholders, "stream closed", etc).
func (t Theme) DimStyle() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.Dim).Italic(true)
}

// ErrorStyle returns the red-bold style for turn errors.
func (t Theme) ErrorStyle() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.Error).Bold(true)
}

// CardBorderStyle returns the rounded-border style for cards.
func (t Theme) CardBorderStyle() lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(t.Border)
}

// StatusBarStyle returns the muted bg/fg used by the status line.
func (t Theme) StatusBarStyle() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(t.Foreground).
		Background(t.Background)
}

// Resolve returns the theme by name. Unknown names return Dark() with the
// returned bool false; callers may log + fall back without erroring.
func Resolve(name string) (Theme, bool) {
	switch name {
	case "light":
		return Light(), true
	case "dark":
		return Dark(), true
	default:
		return Dark(), false
	}
}
```

- [ ] **Step 2 — Write `internal/theme/dark.go`**

Catppuccin Mocha palette (https://github.com/catppuccin/catppuccin):

```go
package theme

import "github.com/charmbracelet/lipgloss"

// Dark returns the Catppuccin Mocha palette — the default theme.
func Dark() Theme {
	return Theme{
		Name:           "dark",
		Background:     lipgloss.Color("#1e1e2e"), // base
		Foreground:     lipgloss.Color("#cdd6f4"), // text
		Dim:            lipgloss.Color("#6c7086"), // overlay1
		Border:         lipgloss.Color("#45475a"), // surface1
		Primary:        lipgloss.Color("#89b4fa"), // blue
		Success:        lipgloss.Color("#a6e3a1"), // green
		Warning:        lipgloss.Color("#f9e2af"), // yellow
		Error:          lipgloss.Color("#f38ba8"), // red
		Info:           lipgloss.Color("#7f849c"), // overlay2
		CodeBackground: lipgloss.Color("#181825"), // mantle
		DiffAdded:      lipgloss.Color("#a6e3a1"), // green
		DiffRemoved:    lipgloss.Color("#f38ba8"), // red
		DiffContext:    lipgloss.Color("#6c7086"), // overlay1
	}
}
```

- [ ] **Step 3 — Write `internal/theme/light.go`**

Catppuccin Latte palette:

```go
package theme

import "github.com/charmbracelet/lipgloss"

// Light returns the Catppuccin Latte palette.
func Light() Theme {
	return Theme{
		Name:           "light",
		Background:     lipgloss.Color("#eff1f5"), // base
		Foreground:     lipgloss.Color("#4c4f69"), // text
		Dim:            lipgloss.Color("#9ca0b0"), // overlay1
		Border:         lipgloss.Color("#bcc0cc"), // surface1
		Primary:        lipgloss.Color("#1e66f5"), // blue
		Success:        lipgloss.Color("#40a02b"), // green
		Warning:        lipgloss.Color("#df8e1d"), // yellow
		Error:          lipgloss.Color("#d20f39"), // red
		Info:           lipgloss.Color("#8c8fa1"), // overlay2
		CodeBackground: lipgloss.Color("#e6e9ef"), // mantle
		DiffAdded:      lipgloss.Color("#40a02b"), // green
		DiffRemoved:    lipgloss.Color("#d20f39"), // red
		DiffContext:    lipgloss.Color("#9ca0b0"), // overlay1
	}
}
```

- [ ] **Step 4 — Write `internal/theme/theme_test.go`**

```go
package theme

import "testing"

func TestDarkPaletteFieldsPopulated(t *testing.T) {
	d := Dark()
	if d.Name != "dark" {
		t.Errorf("name: got %q want dark", d.Name)
	}
	if string(d.Background) == "" || string(d.Foreground) == "" {
		t.Error("dark palette has empty background or foreground")
	}
	if string(d.Primary) == "" || string(d.Error) == "" {
		t.Error("dark palette has empty primary or error")
	}
}

func TestLightPaletteFieldsPopulated(t *testing.T) {
	l := Light()
	if l.Name != "light" {
		t.Errorf("name: got %q want light", l.Name)
	}
	if string(l.Background) == "" || string(l.Foreground) == "" {
		t.Error("light palette has empty background or foreground")
	}
}

func TestResolveKnownNames(t *testing.T) {
	d, ok := Resolve("dark")
	if !ok || d.Name != "dark" {
		t.Errorf("Resolve(dark): got (%v, %v) want (dark, true)", d.Name, ok)
	}
	l, ok := Resolve("light")
	if !ok || l.Name != "light" {
		t.Errorf("Resolve(light): got (%v, %v) want (light, true)", l.Name, ok)
	}
}

func TestResolveUnknownNameFallsBackToDarkWithFalse(t *testing.T) {
	got, ok := Resolve("eldritch-purple")
	if ok {
		t.Error("Resolve(unknown): ok should be false")
	}
	if got.Name != "dark" {
		t.Errorf("Resolve(unknown).Name: got %q want dark (fallback)", got.Name)
	}
}

func TestHeaderStyleAppliesPrimaryAndBold(t *testing.T) {
	d := Dark()
	s := d.HeaderStyle().Render("hi")
	// Header should produce ANSI escapes (color + bold). We only check that
	// the styled output differs from raw "hi" — exact escape codes vary
	// across terminfo databases.
	if s == "hi" {
		t.Error("HeaderStyle should produce ANSI escapes; got raw text")
	}
}
```

- [ ] **Step 5 — Wire theme into `app.Model`**

Modify `packages/tui/internal/app/app.go`:

1. Add import: `"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"`
2. Add `theme theme.Theme` field to `Model` struct.
3. In `New(...)`, after constructing the Model, set `m.theme = theme.Dark()` (default).
4. In the ENTER handler in `Update`, add an interception block for `/theme <name>` BEFORE the existing `/compact` intercept:

```go
if strings.HasPrefix(text, "/theme") {
	m.transcript.AppendLine("» " + text)
	m.prompt.Clear()
	parts := strings.SplitN(text, " ", 2)
	if len(parts) < 2 {
		m.transcript.AppendLine(m.theme.DimStyle().Render("usage: /theme <light|dark>"))
		return m, nil
	}
	name := strings.TrimSpace(parts[1])
	newTheme, ok := theme.Resolve(name)
	if !ok {
		m.transcript.AppendLine(m.theme.ErrorStyle().Render("unknown theme: " + name))
		return m, nil
	}
	m.theme = newTheme
	m.transcript.AppendLine(m.theme.DimStyle().Render("theme: " + name))
	return m, nil
}
```

Note: T1 only ships the model field + slash handler. The actual *consumption* of `m.theme` by components happens incrementally in T3–T10. The other components keep their hardcoded colors until each task swaps them.

- [ ] **Step 6 — Verify**

```bash
cd packages/tui && go test ./internal/theme/... -v
go build ./...
```

Expected: 5 theme tests pass; root package + cmd/sov-tui still build.

- [ ] **Step 7 — Commit**

```
git add packages/tui/internal/theme/ packages/tui/internal/app/app.go packages/tui/internal/app/keys.go
git commit -m "feat(tui): M9 T1 — theme package + /theme slash handler (Catppuccin)"
git push origin master
```

---

## Task 2: Renderer package foundation (markdown + code + plain)

**Goal:** Build `internal/render/` with `Markdown`, `Code`, and `Plain` renderers. Add glamour + chroma to `go.mod`. Pure functions: `(text, theme, width) → string`. No state, no `tea.Msg`. Used by transcript / toolcard in T3+.

**Files:**
- Modify: `packages/tui/go.mod`, `go.sum`
- Create: `packages/tui/internal/render/{markdown,code,plain}.go`, `_test.go` peers

### Steps

- [ ] **Step 1 — Add glamour + chroma to go.mod**

```bash
cd packages/tui
go get github.com/charmbracelet/glamour@latest
go get github.com/alecthomas/chroma/v2@latest
```

Verify added in go.mod's `require ( )` block.

- [ ] **Step 2 — Write `internal/render/plain.go`**

```go
// Package render — pure renderers for the Phase 16.1 TUI. Functions take
// (text, theme, width) and return a styled string. No state, no tea.Msg,
// no I/O (ADR M9-02).
package render

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// Plain renders text wrapped at width, foreground set to theme.Foreground.
// This is the fallback when markdown / chroma parsing fails or when the
// caller has no language hint.
func Plain(text string, t theme.Theme, width int) string {
	if width <= 0 {
		return text
	}
	style := lipgloss.NewStyle().
		Foreground(t.Foreground).
		Width(width)
	return style.Render(strings.TrimRight(text, "\n"))
}
```

- [ ] **Step 3 — Write `internal/render/markdown.go`**

```go
package render

import (
	"github.com/charmbracelet/glamour"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// Markdown renders Github-flavored markdown via glamour. Falls back to Plain
// on any glamour error so the TUI never crashes on garbage input from the
// model. Width is the wrap column (glamour's WordWrap).
func Markdown(text string, t theme.Theme, width int) string {
	if text == "" {
		return ""
	}
	if width <= 0 {
		return text
	}
	style := glamourStyleForTheme(t)
	r, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle(style),
		glamour.WithWordWrap(width),
	)
	if err != nil {
		return Plain(text, t, width)
	}
	out, err := r.Render(text)
	if err != nil {
		return Plain(text, t, width)
	}
	return out
}

// glamourStyleForTheme picks a built-in glamour style closest to our theme.
// glamour's bundled styles handle the syntax highlight + heading colors;
// matching by theme name keeps M9 small. M9.5 may swap to custom glamour
// styles built from theme.Theme tokens.
func glamourStyleForTheme(t theme.Theme) string {
	if t.Name == "light" {
		return "light"
	}
	return "dark"
}
```

- [ ] **Step 4 — Write `internal/render/code.go`**

```go
package render

import (
	"strings"

	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// Code renders a code block with chroma syntax highlighting. language is the
// fence info string (e.g., "go", "ts", "python"). Empty language → Plain.
// Falls back to Plain on chroma error.
func Code(text, language string, t theme.Theme, width int) string {
	if text == "" {
		return ""
	}
	if language == "" {
		return Plain(text, t, width)
	}
	lexer := lexers.Get(language)
	if lexer == nil {
		return Plain(text, t, width)
	}
	style := chromaStyleForTheme(t)
	formatter := formatters.Get("terminal16m")
	if formatter == nil {
		return Plain(text, t, width)
	}
	iter, err := lexer.Tokenise(nil, text)
	if err != nil {
		return Plain(text, t, width)
	}
	var sb strings.Builder
	if err := formatter.Format(&sb, style, iter); err != nil {
		return Plain(text, t, width)
	}
	return sb.String()
}

// chromaStyleForTheme picks the chroma style closest to the theme.
func chromaStyleForTheme(t theme.Theme) *chromaStyle {
	if t.Name == "light" {
		return styles.Get("catppuccin-latte")
	}
	return styles.Get("catppuccin-mocha")
}

// chromaStyle aliases the chroma styles.Style for the helper return type
// (the exported type is unexported in styles, so we re-export through here).
type chromaStyle = styles.Style
```

Note: depending on chroma/v2 version, `styles.Get("catppuccin-mocha")` may not exist. If unavailable, fall back to `styles.Get("monokai")` (dark) and `styles.Get("github")` (light) — both ship with chroma.

- [ ] **Step 5 — Write tests**

`internal/render/plain_test.go`:

```go
package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestPlainWrapsAtWidth(t *testing.T) {
	out := Plain("hello", theme.Dark(), 20)
	if out == "" {
		t.Error("Plain returned empty for non-empty input")
	}
}

func TestPlainEmptyInputReturnsEmpty(t *testing.T) {
	out := Plain("", theme.Dark(), 80)
	if strings.TrimSpace(out) != "" {
		t.Errorf("Plain(empty): expected empty/whitespace, got %q", out)
	}
}

func TestPlainZeroWidthReturnsInput(t *testing.T) {
	in := "hello"
	out := Plain(in, theme.Dark(), 0)
	if out != in {
		t.Errorf("Plain(width=0): want %q got %q", in, out)
	}
}
```

`internal/render/markdown_test.go`:

```go
package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestMarkdownRendersBold(t *testing.T) {
	out := Markdown("**hello**", theme.Dark(), 80)
	if out == "" {
		t.Error("Markdown returned empty for non-empty input")
	}
	// glamour produces ANSI bold; we only assert non-empty + non-raw.
	if strings.TrimSpace(out) == "**hello**" {
		t.Error("Markdown should transform raw markdown; got raw input")
	}
}

func TestMarkdownEmptyInputReturnsEmpty(t *testing.T) {
	out := Markdown("", theme.Dark(), 80)
	if out != "" {
		t.Errorf("Markdown(empty): expected empty, got %q", out)
	}
}

func TestMarkdownHeaderRenders(t *testing.T) {
	out := Markdown("# Title\n\nbody", theme.Dark(), 80)
	if !strings.Contains(out, "Title") {
		t.Errorf("Markdown header: missing Title text: %q", out)
	}
}
```

`internal/render/code_test.go`:

```go
package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestCodeHighlightsGo(t *testing.T) {
	src := `package main
func main() { println("hi") }`
	out := Code(src, "go", theme.Dark(), 80)
	if out == "" {
		t.Error("Code returned empty for non-empty input")
	}
	// chroma should produce ANSI escapes for keywords; output must not equal raw input.
	if out == src {
		t.Error("Code should transform; got raw input")
	}
}

func TestCodeNoLanguageFallsBackToPlain(t *testing.T) {
	out := Code("hello", "", theme.Dark(), 80)
	if out == "" {
		t.Error("Code(no language): expected non-empty (Plain fallback)")
	}
}

func TestCodeUnknownLanguageFallsBackToPlain(t *testing.T) {
	out := Code("hello", "made-up-lang-9000", theme.Dark(), 80)
	if !strings.Contains(out, "hello") {
		t.Errorf("Code(unknown language): expected plain fallback containing input; got %q", out)
	}
}
```

- [ ] **Step 6 — Verify**

```bash
cd packages/tui && go test ./internal/render/... -v
```

Expected: all render tests pass.

- [ ] **Step 7 — Commit**

```
git add packages/tui/go.mod packages/tui/go.sum packages/tui/internal/render/
git commit -m "feat(tui): M9 T2 — render package (markdown + code + plain) with glamour + chroma"
git push origin master
```

---

## Task 3: Markdown wiring into transcript

**Goal:** Route assistant `text` blocks through `render/Markdown` before appending to the transcript. Current behavior appends raw text via `AppendLine`. Change `text_delta` handling to buffer the current assistant card and re-render it through markdown on each delta. Debounce to ~60Hz.

**Files:**
- Modify: `packages/tui/internal/components/transcript.go` (add per-card buffering)
- Modify: `packages/tui/internal/app/app.go` (update text_delta handler to update card instead of append)

### Steps

- [ ] **Step 1 — Extend `Transcript` with a current-assistant-card buffer**

In `transcript.go`, add fields + helpers:

```go
type Transcript struct {
	vp                  viewport.Model
	lines               []string
	width               int
	height              int
	atBottom            bool

	// M9 T3 — buffered current-assistant card. Streaming text_delta events
	// append to this buffer and trigger a single re-render in place of the
	// previous draft. nil means no in-progress assistant card; the next
	// text_delta starts one.
	currentAssistant    *strings.Builder
	currentAssistantIdx int           // index into lines[] where the rendered card lives
	theme               theme.Theme
}

// SetTheme updates the theme used to re-render cards. Called from app.go when
// the user runs /theme <name>. Re-renders any in-progress assistant card.
func (t *Transcript) SetTheme(th theme.Theme) {
	t.theme = th
	if t.currentAssistant != nil {
		rendered := render.Markdown(t.currentAssistant.String(), t.theme, t.width)
		t.lines[t.currentAssistantIdx] = rendered
		t.vp.SetContent(joinLines(t.lines))
	}
}

// AppendAssistantDelta appends a text_delta to the current assistant card
// and re-renders. The first call starts a new card (appends a line); later
// calls update the same line in place.
func (t *Transcript) AppendAssistantDelta(delta string) {
	if t.currentAssistant == nil {
		t.currentAssistant = &strings.Builder{}
		t.currentAssistantIdx = len(t.lines)
		t.lines = append(t.lines, "")
	}
	t.currentAssistant.WriteString(delta)
	rendered := render.Markdown(t.currentAssistant.String(), t.theme, t.width)
	t.lines[t.currentAssistantIdx] = rendered
	t.vp.SetContent(joinLines(t.lines))
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
}

// EndAssistantCard finalizes the current card; subsequent text_delta starts
// a new card. Called from app.go on turn_complete and any non-text_delta
// event interrupting the assistant.
func (t *Transcript) EndAssistantCard() {
	t.currentAssistant = nil
	t.currentAssistantIdx = 0
}
```

Constructor change — `NewTranscript` now takes a theme:

```go
func NewTranscript(th theme.Theme) Transcript {
	vp := viewport.New(80, 20)
	return Transcript{vp: vp, atBottom: true, theme: th}
}
```

Add the import: `"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/render"` and `"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"`.

- [ ] **Step 2 — Update `app.go`**

In `New()`, change:

```go
transcript: components.NewTranscript(),
```

to:

```go
transcript: components.NewTranscript(theme.Dark()),
```

(theme.Dark() is the default; `/theme` slash will update via `m.transcript.SetTheme(m.theme)` after change).

In the `/theme` slash handler from T1, after setting `m.theme = newTheme`, also call:

```go
m.transcript.SetTheme(m.theme)
```

In `handleEvent` for `text_delta`, change:

```go
case "text_delta":
	td, err := transport.DecodeTextDelta(env.Raw)
	if err != nil {
		return
	}
	m.clearThinkingIfPending()
	m.transcript.AppendLine(td.Text)
```

to:

```go
case "text_delta":
	td, err := transport.DecodeTextDelta(env.Raw)
	if err != nil {
		return
	}
	m.clearThinkingIfPending()
	m.transcript.AppendAssistantDelta(td.Text)
```

In `handleEvent` for `turn_complete` and `tool_use_start`, add `m.transcript.EndAssistantCard()` at the start (interrupt streaming).

In `handleEvent` for `tool_result`, also call `m.transcript.EndAssistantCard()` before adding the tool card.

- [ ] **Step 3 — Add transcript_test.go**

`packages/tui/internal/components/transcript_test.go`:

```go
package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestTranscriptStartsWithoutAssistantCard(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	// No-op: just ensure no panic.
	_ = tr.View()
}

func TestTranscriptAppendAssistantDeltaRendersMarkdown(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendAssistantDelta("**bold**")
	// The rendered line should not contain the raw "**" — glamour transforms.
	rendered := tr.View()
	if strings.Contains(rendered, "**bold**") {
		t.Errorf("AppendAssistantDelta: raw markdown leaked into rendered view: %q", rendered)
	}
}

func TestTranscriptEndAssistantCardStartsNewCardOnNextDelta(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendAssistantDelta("hello")
	tr.EndAssistantCard()
	tr.AppendAssistantDelta("world")
	// Both should be present in distinct lines.
	rendered := tr.View()
	if !strings.Contains(rendered, "hello") || !strings.Contains(rendered, "world") {
		t.Errorf("EndAssistantCard: did not preserve prior content: %q", rendered)
	}
}
```

- [ ] **Step 4 — Build + test**

```bash
cd packages/tui && go build ./... && go test ./internal/components/... -v
```

If `Transcript.AppendLine` is still referenced from app.go (it should be — for user-prefix "» " lines, tool cards, etc.), the build will succeed. New tests pass.

- [ ] **Step 5 — Commit**

```
git add packages/tui/internal/components/transcript.go packages/tui/internal/components/transcript_test.go packages/tui/internal/app/app.go
git commit -m "feat(tui): M9 T3 — markdown rendering for assistant text via render/Markdown"
git push origin master
```

---

## Task 4: Syntax highlight on code blocks

**Goal:** Code blocks inside assistant markdown already light up via glamour (T2/T3). Add separate syntax highlighting for tool input/output where `RenderHint === 'code'` or where the tool result carries a `language` field. Update `toolcard.go` to detect these and route through `render.Code`.

**Files:**
- Modify: `packages/tui/internal/components/toolcard.go` (add language field + theme + Code rendering when hint is `code` or `language` is set)
- Modify: `packages/tui/internal/app/app.go` (pass language + Theme to ToolCard constructor)

### Steps

- [ ] **Step 1 — Extend `ToolCard` struct**

In `toolcard.go`:

```go
type ToolCard struct {
	Tool       string
	RenderHint string
	Summary    string
	Output     string       // M9 T4 — raw tool output (rendered via render.Code when language is set)
	Language   string       // M9 T4 — from ToolResult.Language wire field
	Theme      theme.Theme  // M9 T4 — for chroma styling
	Expanded   bool         // M9 T6 — collapsed by default; user toggles via /expand
}
```

Add the imports:

```go
import (
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)
```

- [ ] **Step 2 — Update `View` to use Code rendering on hint=code/language present**

```go
func (tc ToolCard) View(width int) string {
	if width <= 4 {
		return fmt.Sprintf("[%s] %s", tc.Tool, tc.Summary)
	}
	header := tc.Theme.HeaderStyle().Render(fmt.Sprintf("> %s", tc.Tool))
	var body string
	if tc.Expanded && tc.Output != "" {
		if tc.Language != "" || tc.RenderHint == "code" {
			body = render.Code(tc.Output, tc.Language, tc.Theme, width-4)
		} else {
			body = render.Plain(tc.Output, tc.Theme, width-4)
		}
	} else {
		body = lipgloss.NewStyle().Foreground(tc.Theme.Info).Render(tc.Summary)
	}
	box := tc.Theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(header + "\n" + body)
}
```

- [ ] **Step 3 — Update `app.go` to populate the new fields**

In the `tool_result` case of `handleEvent`, change the ToolCard construction:

```go
card := components.ToolCard{
	Tool:       tr.Tool,
	RenderHint: hint,
	Summary:    fmt.Sprintf("rendered as %s", hint),
	Output:     string(tr.Output),
	Language:   tr.Language,
	Theme:      m.theme,
	Expanded:   false, // collapsed by default
}
```

- [ ] **Step 4 — Test**

Extend `internal/components` tests:

```go
// In a new file packages/tui/internal/components/toolcard_test.go (or extend if exists)
package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestToolCardCollapsedShowsSummary(t *testing.T) {
	tc := ToolCard{
		Tool:    "FileRead",
		Summary: "rendered as text",
		Theme:   theme.Dark(),
	}
	view := tc.View(80)
	if !strings.Contains(view, "FileRead") || !strings.Contains(view, "rendered as text") {
		t.Errorf("collapsed card missing tool name or summary: %q", view)
	}
}

func TestToolCardExpandedWithLanguageHighlightsCode(t *testing.T) {
	tc := ToolCard{
		Tool:     "FileRead",
		Output:   "package main\nfunc main() {}",
		Language: "go",
		Theme:    theme.Dark(),
		Expanded: true,
	}
	view := tc.View(80)
	if strings.Contains(view, "rendered as text") {
		t.Error("expanded card should show output, not summary")
	}
	if !strings.Contains(view, "main") {
		t.Errorf("expanded card missing output content: %q", view)
	}
}

func TestToolCardZeroThemeDoesNotPanic(t *testing.T) {
	tc := ToolCard{Tool: "x", Summary: "y"}
	// Should not panic on zero theme — the styles fall back to empty Color
	// values which lipgloss renders as no-op.
	_ = tc.View(80)
}
```

- [ ] **Step 5 — Verify**

```bash
cd packages/tui && go build ./... && go test ./internal/components/... -v
```

- [ ] **Step 6 — Commit**

```
git add packages/tui/internal/components/toolcard.go packages/tui/internal/components/toolcard_test.go packages/tui/internal/app/app.go
git commit -m "feat(tui): M9 T4 — chroma syntax highlight on tool-result code blocks"
git push origin master
```

---

## Task 5: Inline diff renderer + hunk navigation

**Goal:** Add `render/diff.go` that parses a unified-diff string into `Hunks` and renders each hunk with chroma syntax highlight. Add `components/diffview.go` (focused-state component with `j`/`k` keybindings). Update `toolcard.go` to detect `FileEdit` / `FileWrite` results and route through the diff renderer.

**Files:**
- Create: `packages/tui/internal/render/diff.go`, `diff_test.go`
- Create: `packages/tui/internal/components/diffview.go`, `diffview_test.go`
- Modify: `packages/tui/internal/components/toolcard.go` (detect FileEdit/FileWrite + delegate to diffview)
- Modify: `packages/tui/internal/app/app.go` (track focused diffview; route `j`/`k` keys when focused)
- Modify: `packages/tui/internal/app/keys.go` (`j`/`k` + Ctrl+] focus binding)

### Steps

- [ ] **Step 1 — Write `render/diff.go`**

```go
package render

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// Hunk is a parsed diff hunk — header + body lines, each tagged with diff
// status. v1 ignores file rename / mode metadata; only unified-diff bodies.
type Hunk struct {
	Header string  // e.g., "@@ -1,4 +1,5 @@"
	Lines  []HunkLine
}

type HunkLine struct {
	Kind DiffLineKind
	Text string // without the leading +/-/' ' marker
}

type DiffLineKind int

const (
	DiffContext DiffLineKind = iota
	DiffAdded
	DiffRemoved
)

// ParseDiff splits a unified diff into hunks. Returns an empty slice for
// input that contains no hunk headers. The parser is intentionally lenient
// — malformed bodies pass through as DiffContext lines so the caller can
// always render something.
func ParseDiff(text string) []Hunk {
	var hunks []Hunk
	var current *Hunk
	for _, raw := range strings.Split(text, "\n") {
		if strings.HasPrefix(raw, "@@") {
			if current != nil {
				hunks = append(hunks, *current)
			}
			current = &Hunk{Header: raw}
			continue
		}
		if current == nil {
			continue
		}
		switch {
		case strings.HasPrefix(raw, "+"):
			current.Lines = append(current.Lines, HunkLine{Kind: DiffAdded, Text: raw[1:]})
		case strings.HasPrefix(raw, "-"):
			current.Lines = append(current.Lines, HunkLine{Kind: DiffRemoved, Text: raw[1:]})
		default:
			text := raw
			if strings.HasPrefix(raw, " ") {
				text = raw[1:]
			}
			current.Lines = append(current.Lines, HunkLine{Kind: DiffContext, Text: text})
		}
	}
	if current != nil {
		hunks = append(hunks, *current)
	}
	return hunks
}

// RenderHunks renders all hunks with the hunk at activeIdx highlighted via
// a left-border accent. activeIdx out of bounds is treated as -1 (no
// highlight). width is the wrap column.
func RenderHunks(hunks []Hunk, activeIdx int, t theme.Theme, width int) string {
	if len(hunks) == 0 {
		return ""
	}
	addStyle := lipgloss.NewStyle().Foreground(t.DiffAdded)
	remStyle := lipgloss.NewStyle().Foreground(t.DiffRemoved)
	ctxStyle := lipgloss.NewStyle().Foreground(t.DiffContext)
	headerStyle := lipgloss.NewStyle().Foreground(t.Primary).Bold(true)
	var sb strings.Builder
	for i, h := range hunks {
		hdr := headerStyle.Render(h.Header)
		if i == activeIdx {
			hdr = lipgloss.NewStyle().Foreground(t.Warning).Bold(true).Render("▶ " + h.Header)
		}
		sb.WriteString(hdr)
		sb.WriteString("\n")
		for _, line := range h.Lines {
			switch line.Kind {
			case DiffAdded:
				sb.WriteString(addStyle.Render("+ " + line.Text))
			case DiffRemoved:
				sb.WriteString(remStyle.Render("- " + line.Text))
			default:
				sb.WriteString(ctxStyle.Render("  " + line.Text))
			}
			sb.WriteString("\n")
		}
		if i < len(hunks)-1 {
			sb.WriteString("\n")
		}
	}
	// width-truncate is left to the caller (toolcard adjusts its box width).
	_ = width
	_ = fmt.Sprintf // placeholder if needed later
	return sb.String()
}
```

- [ ] **Step 2 — Write `render/diff_test.go`**

```go
package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestParseDiffSplitsHunks(t *testing.T) {
	input := `@@ -1,3 +1,4 @@
 context line 1
-old line
+new line
 context line 2
@@ -10,2 +10,3 @@
 ctx
+added
`
	got := ParseDiff(input)
	if len(got) != 2 {
		t.Fatalf("got %d hunks, want 2", len(got))
	}
	if got[0].Header != "@@ -1,3 +1,4 @@" {
		t.Errorf("hunk 0 header: %q", got[0].Header)
	}
	if len(got[0].Lines) != 4 {
		t.Errorf("hunk 0: got %d lines, want 4", len(got[0].Lines))
	}
	if got[1].Header != "@@ -10,2 +10,3 @@" {
		t.Errorf("hunk 1 header: %q", got[1].Header)
	}
}

func TestParseDiffMarksAddedRemovedContext(t *testing.T) {
	input := `@@ -1 +1 @@
-removed
+added
 context
`
	hunks := ParseDiff(input)
	if len(hunks) != 1 {
		t.Fatalf("got %d hunks", len(hunks))
	}
	kinds := []DiffLineKind{}
	for _, l := range hunks[0].Lines {
		kinds = append(kinds, l.Kind)
	}
	want := []DiffLineKind{DiffRemoved, DiffAdded, DiffContext}
	if len(kinds) != len(want) {
		t.Fatalf("kinds: got %v want %v", kinds, want)
	}
	for i := range kinds {
		if kinds[i] != want[i] {
			t.Errorf("kind[%d]: got %v want %v", i, kinds[i], want[i])
		}
	}
}

func TestParseDiffEmptyInputReturnsEmpty(t *testing.T) {
	hunks := ParseDiff("")
	if len(hunks) != 0 {
		t.Errorf("got %d hunks for empty input, want 0", len(hunks))
	}
}

func TestRenderHunksMarksActiveHunk(t *testing.T) {
	hunks := []Hunk{
		{Header: "@@ a", Lines: []HunkLine{{Kind: DiffContext, Text: "x"}}},
		{Header: "@@ b", Lines: []HunkLine{{Kind: DiffContext, Text: "y"}}},
	}
	out := RenderHunks(hunks, 1, theme.Dark(), 80)
	if !strings.Contains(out, "▶") {
		t.Errorf("active hunk should have ▶ marker; got: %q", out)
	}
}

func TestRenderHunksOutOfBoundsClampsToNoActive(t *testing.T) {
	hunks := []Hunk{{Header: "@@ a", Lines: nil}}
	out := RenderHunks(hunks, 99, theme.Dark(), 80)
	// Should not panic; no ▶ marker.
	if strings.Contains(out, "▶") {
		t.Errorf("out-of-bounds activeIdx should not mark any hunk; got: %q", out)
	}
}
```

- [ ] **Step 3 — Write `components/diffview.go`**

```go
package components

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// DiffView is a focused-state component. When focused (model.focus == "diffview"),
// j/k cycle the active hunk; out-of-range clamps. When unfocused, View
// renders without the active-hunk indicator (a flat all-hunks dump).
type DiffView struct {
	Hunks       []render.Hunk
	activeHunk  int
	focused     bool
	theme       theme.Theme
}

func NewDiffView(text string, t theme.Theme) DiffView {
	return DiffView{
		Hunks:       render.ParseDiff(text),
		activeHunk:  0,
		theme:       t,
	}
}

func (dv *DiffView) SetFocused(b bool) { dv.focused = b }
func (dv DiffView) Focused() bool      { return dv.focused }
func (dv DiffView) ActiveHunk() int    { return dv.activeHunk }

// Update handles j/k when focused. Returns the next state.
func (dv DiffView) Update(msg tea.Msg) DiffView {
	if !dv.focused {
		return dv
	}
	keyMsg, ok := msg.(tea.KeyMsg)
	if !ok {
		return dv
	}
	switch keyMsg.String() {
	case "j":
		if dv.activeHunk+1 < len(dv.Hunks) {
			dv.activeHunk++
		}
	case "k":
		if dv.activeHunk > 0 {
			dv.activeHunk--
		}
	}
	return dv
}

func (dv DiffView) View(width int) string {
	active := -1
	if dv.focused {
		active = dv.activeHunk
	}
	return render.RenderHunks(dv.Hunks, active, dv.theme, width)
}
```

- [ ] **Step 4 — Write `components/diffview_test.go`**

```go
package components

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestDiffViewParseHunks(t *testing.T) {
	dv := NewDiffView("@@ -1 +1 @@\n+added\n", theme.Dark())
	if len(dv.Hunks) != 1 {
		t.Errorf("got %d hunks, want 1", len(dv.Hunks))
	}
}

func TestDiffViewJCyclesForward(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n@@ c\n", theme.Dark())
	dv.SetFocused(true)
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if dv.ActiveHunk() != 1 {
		t.Errorf("j: got activeHunk=%d want 1", dv.ActiveHunk())
	}
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if dv.ActiveHunk() != 2 {
		t.Errorf("jj: got activeHunk=%d want 2", dv.ActiveHunk())
	}
}

func TestDiffViewJClampsAtLastHunk(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n", theme.Dark())
	dv.SetFocused(true)
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if dv.ActiveHunk() != 1 {
		t.Errorf("clamp: got %d want 1", dv.ActiveHunk())
	}
}

func TestDiffViewKClampsAtFirstHunk(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n", theme.Dark())
	dv.SetFocused(true)
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if dv.ActiveHunk() != 0 {
		t.Errorf("k at 0: got %d want 0", dv.ActiveHunk())
	}
}

func TestDiffViewIgnoresKeysWhenUnfocused(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n", theme.Dark())
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if dv.ActiveHunk() != 0 {
		t.Errorf("unfocused: got %d want 0", dv.ActiveHunk())
	}
}
```

- [ ] **Step 5 — Wire diff routing in toolcard.go**

Update `ToolCard.View`: when `Tool == "FileEdit"` or `Tool == "FileWrite"` and `Output` looks like a unified diff (contains `@@`), render via `DiffView`. Simpler: extend `ToolCard` with an optional `Diff *DiffView` pointer; if set, the View renders the diff. Wiring in `app.go`'s `tool_result` handler.

In `toolcard.go`:

```go
type ToolCard struct {
	// ... existing fields ...
	Diff *DiffView // M9 T5 — when set, View renders the diff instead of the plain body
}

func (tc ToolCard) View(width int) string {
	if width <= 4 {
		return fmt.Sprintf("[%s] %s", tc.Tool, tc.Summary)
	}
	header := tc.Theme.HeaderStyle().Render(fmt.Sprintf("> %s", tc.Tool))
	var body string
	if tc.Diff != nil && tc.Expanded {
		body = tc.Diff.View(width - 4)
	} else if tc.Expanded && tc.Output != "" {
		if tc.Language != "" || tc.RenderHint == "code" {
			body = render.Code(tc.Output, tc.Language, tc.Theme, width-4)
		} else {
			body = render.Plain(tc.Output, tc.Theme, width-4)
		}
	} else {
		body = lipgloss.NewStyle().Foreground(tc.Theme.Info).Render(tc.Summary)
	}
	box := tc.Theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(header + "\n" + body)
}
```

In `app.go` `tool_result` handler, when `tr.Tool == "FileEdit" || tr.Tool == "FileWrite"`:

```go
var diff *components.DiffView
if tr.Tool == "FileEdit" || tr.Tool == "FileWrite" {
	dv := components.NewDiffView(string(tr.Output), m.theme)
	if len(dv.Hunks) > 0 {
		diff = &dv
	}
}
card := components.ToolCard{
	Tool:       tr.Tool,
	RenderHint: hint,
	Summary:    fmt.Sprintf("rendered as %s", hint),
	Output:     string(tr.Output),
	Language:   tr.Language,
	Theme:      m.theme,
	Expanded:   diff != nil, // auto-expand diffs
	Diff:       diff,
}
```

Also track in `Model`:

```go
type Model struct {
	// ... existing fields ...
	mostRecentDiff *components.DiffView // M9 T5 — points to the diff in the latest tool_result card; Ctrl+] focuses it
	focus          focusTarget          // M9 T5 — transcript | diffview | autocomplete
}

type focusTarget int

const (
	focusTranscript focusTarget = iota
	focusDiffView
	focusAutocomplete
)
```

After constructing the card, update `m.mostRecentDiff = diff` when not nil.

- [ ] **Step 6 — Update keys.go and Update to route j/k**

In `keys.go` add `j`/`k` bindings (informational; the routing is in Update). In `Update`'s `tea.KeyMsg` branch, BEFORE the permission modal check:

```go
// M9 T5 — diff view focus routing
if msg.String() == "ctrl+]" {
	if m.mostRecentDiff != nil {
		m.mostRecentDiff.SetFocused(true)
		m.focus = focusDiffView
	}
	return m, nil
}
if msg.String() == "esc" && m.focus == focusDiffView {
	if m.mostRecentDiff != nil {
		m.mostRecentDiff.SetFocused(false)
	}
	m.focus = focusTranscript
	return m, nil
}
if m.focus == focusDiffView && m.mostRecentDiff != nil {
	updated := m.mostRecentDiff.Update(msg)
	m.mostRecentDiff = &updated
	return m, nil
}
```

Note: the existing `esc` quit at the top of the KeyMsg branch needs to be gated so when focus is diffview, esc unfocuses instead of quitting. Move the `m.focus == focusDiffView` check above the esc-quit handler.

- [ ] **Step 7 — Test + commit**

```bash
cd packages/tui && go test ./... -v
```

```
git add packages/tui/internal/render/diff.go packages/tui/internal/render/diff_test.go packages/tui/internal/components/diffview.go packages/tui/internal/components/diffview_test.go packages/tui/internal/components/toolcard.go packages/tui/internal/app/app.go packages/tui/internal/app/keys.go
git commit -m "feat(tui): M9 T5 — inline diff renderer + diffview component with j/k hunk nav"
git push origin master
```

---

## Task 6: Styled tool cards (final polish pass)

**Goal:** T4 wired basic chroma highlight; T5 wired diff routing. T6 finalizes the toolcard's visual design: themed border, themed header, themed dim summary, collapsed-by-default, theme-token consumption end-to-end.

This task is mostly verification + light polish on toolcard.go since T4/T5 already did the structural work.

**Files:**
- Modify: `packages/tui/internal/components/toolcard.go` (final polish — ensure all `lipgloss.NewStyle` calls go through theme)

### Steps

- [ ] **Step 1 — Audit toolcard.go for hardcoded colors**

Run:

```bash
grep -n 'lipgloss.Color\|#[0-9a-f]\{6\}' packages/tui/internal/components/toolcard.go
```

Any remaining hardcoded `#xxxxxx` strings (outside of T4/T5 work) get replaced with `tc.Theme.<accessor>`.

- [ ] **Step 2 — Polish toolcard.go**

Final shape:

```go
package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

type ToolCard struct {
	Tool       string
	RenderHint string
	Summary    string
	Output     string
	Language   string
	Theme      theme.Theme
	Expanded   bool
	Diff       *DiffView
}

func (tc ToolCard) View(width int) string {
	if width <= 4 {
		return fmt.Sprintf("[%s] %s", tc.Tool, tc.Summary)
	}
	header := tc.Theme.HeaderStyle().Render(fmt.Sprintf("> %s", tc.Tool))
	var body string
	switch {
	case tc.Diff != nil && tc.Expanded:
		body = tc.Diff.View(width - 4)
	case tc.Expanded && tc.Output != "":
		if tc.Language != "" || tc.RenderHint == "code" {
			body = render.Code(tc.Output, tc.Language, tc.Theme, width-4)
		} else {
			body = render.Plain(tc.Output, tc.Theme, width-4)
		}
	default:
		summaryStyle := lipgloss.NewStyle().Foreground(tc.Theme.Info)
		body = summaryStyle.Render(tc.Summary)
	}
	box := tc.Theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(header + "\n" + body)
}
```

- [ ] **Step 3 — Verify no hardcoded colors remain**

Re-run:

```bash
grep -n 'lipgloss.Color\|#[0-9a-f]\{6\}' packages/tui/internal/components/toolcard.go
```

Expected: only `lipgloss.NewStyle().Foreground(tc.Theme.Info)` (a theme accessor; no literal color).

- [ ] **Step 4 — Test**

```bash
cd packages/tui && go test ./internal/components/... -v
```

Tests already written in T4 + T5 cover this.

- [ ] **Step 5 — Commit**

```
git add packages/tui/internal/components/toolcard.go
git commit -m "feat(tui): M9 T6 — toolcard final polish (theme tokens end-to-end)"
git push origin master
```

---

## Task 7: Goodbye card + compaction marker + #39 Go mirror

**Goal:** New `components/goodbye.go` consumes the rich `SessionSummaryEvent` from M8 T7 and renders a styled card. New `components/compactioncard.go` renders an inline pill for `compaction_complete` events. Extend `transport/types.go` with the Go mirror struct for `SessionSummaryEvent` (closes backlog #39).

**Files:**
- Create: `packages/tui/internal/components/goodbye.go`, `goodbye_test.go`
- Create: `packages/tui/internal/components/compactioncard.go`, `compactioncard_test.go`
- Modify: `packages/tui/internal/transport/types.go` (add `SessionSummary` struct + `DecodeSessionSummary`)
- Modify: `packages/tui/internal/app/app.go` (handle `session_summary` SSE event → goodbye render; handle `compaction_complete` → compaction marker card)

### Steps

- [ ] **Step 1 — Add Go mirror for SessionSummary in transport/types.go**

Add after existing types:

```go
// SessionSummary mirrors src/server/schema.ts's SessionSummaryEvent (M7 base
// shape + M8 T7 extension fields). Emitted by disposeSession when an attached
// bus is supplied. Extension fields (tokens, durations, tool counts) are
// pointer-or-zero-checked because M7-vintage emissions don't include them.
type SessionSummary struct {
	Type            string             `json:"type"`
	Seq             int64              `json:"seq"`
	SessionID       string             `json:"sessionId"`
	TotalDispatched int                `json:"totalDispatched"`
	ByAgent         map[string]int     `json:"byAgent"`
	Tokens          *SessionTokens     `json:"tokens,omitempty"`
	StartedAtMs     *float64           `json:"startedAtMs,omitempty"`
	EndedAtMs       *float64           `json:"endedAtMs,omitempty"`
	AgentActiveMs   *float64           `json:"agentActiveMs,omitempty"`
	APITimeMs       *float64           `json:"apiTimeMs,omitempty"`
	ToolTimeMs      *float64           `json:"toolTimeMs,omitempty"`
	ToolCalls       *int               `json:"toolCalls,omitempty"`
	ToolOk          *int               `json:"toolOk,omitempty"`
	ToolErr         *int               `json:"toolErr,omitempty"`
}

type SessionTokens struct {
	Input            int     `json:"input"`
	Output           int     `json:"output"`
	CacheRead        *int    `json:"cacheRead,omitempty"`
	CacheWrite       *int    `json:"cacheWrite,omitempty"`
	EstimatedCostUsd float64 `json:"estimatedCostUsd"`
}

func DecodeSessionSummary(raw []byte) (SessionSummary, error) {
	var t SessionSummary
	err := json.Unmarshal(raw, &t)
	return t, err
}
```

- [ ] **Step 2 — Write `components/goodbye.go`**

```go
// Package components — GoodbyeCard: styled session-summary panel rendered
// on /quit (M9 T7). Consumes the rich SessionSummaryEvent payload from M8
// T7 (tokens, cost, durations, tool counts) and degrades gracefully when
// the M8 extension fields are absent (M7-vintage payloads).
//
// ADR M9-09 — render M7-shape minimum (totalDispatched + byAgent) when
// the extension fields are nil; suppress the rich block.

package components

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

// RenderGoodbye produces the centered card string. Width and height are the
// outer terminal dimensions; the card sizes itself ~60% wide and centered.
func RenderGoodbye(summary transport.SessionSummary, t theme.Theme, width, height int) string {
	if width <= 0 || height <= 0 {
		return ""
	}
	cardWidth := width * 3 / 5
	if cardWidth < 40 {
		cardWidth = width - 4
	}

	titleStyle := lipgloss.NewStyle().Foreground(t.Primary).Bold(true)
	labelStyle := lipgloss.NewStyle().Foreground(t.Dim)
	valStyle := lipgloss.NewStyle().Foreground(t.Foreground)

	var lines []string
	lines = append(lines, titleStyle.Render("Session summary"))
	lines = append(lines, "")

	// Token + cost block (M8 T7 extension fields).
	if summary.Tokens != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("tokens in "), valStyle.Render(fmt.Sprintf("%d", summary.Tokens.Input))))
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("tokens out"), valStyle.Render(fmt.Sprintf("%d", summary.Tokens.Output))))
		if summary.Tokens.CacheRead != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render("cache read"), valStyle.Render(fmt.Sprintf("%d", *summary.Tokens.CacheRead))))
		}
		if summary.Tokens.CacheWrite != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render("cache wrt "), valStyle.Render(fmt.Sprintf("%d", *summary.Tokens.CacheWrite))))
		}
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("est cost  "), valStyle.Render(fmt.Sprintf("$%.4f", summary.Tokens.EstimatedCostUsd))))
		lines = append(lines, "")
	}

	// Tool block (M8 T7 extension fields).
	if summary.ToolCalls != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("tool calls"), valStyle.Render(fmt.Sprintf("%d", *summary.ToolCalls))))
		if summary.ToolOk != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render("  ok      "), valStyle.Render(fmt.Sprintf("%d", *summary.ToolOk))))
		}
		if summary.ToolErr != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render("  err     "), valStyle.Render(fmt.Sprintf("%d", *summary.ToolErr))))
		}
		lines = append(lines, "")
	}

	// Duration block (M8 T7 extension fields).
	if summary.AgentActiveMs != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("active ms "), valStyle.Render(fmt.Sprintf("%.0f", *summary.AgentActiveMs))))
	}
	if summary.APITimeMs != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("api ms    "), valStyle.Render(fmt.Sprintf("%.0f", *summary.APITimeMs))))
	}
	if summary.ToolTimeMs != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("tool ms   "), valStyle.Render(fmt.Sprintf("%.0f", *summary.ToolTimeMs))))
	}

	// M7 base shape (always shown).
	lines = append(lines, "")
	lines = append(lines, fmt.Sprintf("%s  %s",
		labelStyle.Render("forks     "), valStyle.Render(fmt.Sprintf("%d", summary.TotalDispatched))))
	for agent, n := range summary.ByAgent {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("  "+padRight(agent, 8)), valStyle.Render(fmt.Sprintf("%d", n))))
	}

	body := strings.Join(lines, "\n")
	box := t.CardBorderStyle().Padding(1, 2).Width(cardWidth).Render(body)
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

func padRight(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}
```

- [ ] **Step 3 — Write `components/goodbye_test.go`**

```go
package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

func TestGoodbyeRichPayloadRendersAllFields(t *testing.T) {
	toolCalls := 5
	toolOk := 4
	toolErr := 1
	cr := 1024
	cw := 256
	summary := transport.SessionSummary{
		TotalDispatched: 2,
		ByAgent:         map[string]int{"review-memory": 1, "review-skill": 1},
		Tokens: &transport.SessionTokens{
			Input:            100,
			Output:           200,
			CacheRead:        &cr,
			CacheWrite:       &cw,
			EstimatedCostUsd: 0.0042,
		},
		ToolCalls: &toolCalls,
		ToolOk:    &toolOk,
		ToolErr:   &toolErr,
	}
	out := RenderGoodbye(summary, theme.Dark(), 120, 40)
	for _, want := range []string{
		"Session summary",
		"tokens in", "100",
		"tokens out", "200",
		"cache read", "1024",
		"cache wrt", "256",
		"$0.0042",
		"tool calls", "5",
		"ok", "4",
		"err", "1",
		"forks", "2",
		"review-memory",
		"review-skill",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("goodbye missing %q in:\n%s", want, out)
		}
	}
}

func TestGoodbyeM7ShapeOmitsExtensionFields(t *testing.T) {
	// M7-shape: no tokens, no toolCalls, no durations.
	summary := transport.SessionSummary{
		TotalDispatched: 1,
		ByAgent:         map[string]int{"review-memory": 1},
	}
	out := RenderGoodbye(summary, theme.Dark(), 120, 40)
	// Should still contain forks block.
	if !strings.Contains(out, "forks") {
		t.Errorf("M7-shape goodbye missing forks: %s", out)
	}
	// Should NOT contain rich block markers.
	if strings.Contains(out, "tokens in") {
		t.Errorf("M7-shape goodbye should omit tokens block; got: %s", out)
	}
	if strings.Contains(out, "tool calls") {
		t.Errorf("M7-shape goodbye should omit tool calls block; got: %s", out)
	}
}

func TestGoodbyeZeroDimensionsReturnsEmpty(t *testing.T) {
	out := RenderGoodbye(transport.SessionSummary{}, theme.Dark(), 0, 0)
	if out != "" {
		t.Errorf("zero dims: expected empty, got %q", out)
	}
}
```

- [ ] **Step 4 — Write `components/compactioncard.go`**

```go
package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// RenderCompactionCard renders a full-width inline pill marking a
// compaction_complete event in the transcript (M8-08: marker is an inline
// transcript element, not a status-line indicator).
func RenderCompactionCard(beforeTokens, afterTokens int, newSessionShortID string, t theme.Theme, width int) string {
	if width <= 4 {
		return fmt.Sprintf("« compacted %d→%d »", beforeTokens, afterTokens)
	}
	label := fmt.Sprintf("« compacted %d→%d tokens — new session %s »",
		beforeTokens, afterTokens, newSessionShortID)
	style := lipgloss.NewStyle().
		Foreground(t.Warning).
		Background(t.Background).
		Bold(true).
		Width(width).
		Align(lipgloss.Center).
		BorderStyle(lipgloss.NormalBorder()).
		BorderTop(true).
		BorderBottom(true).
		BorderForeground(t.Border)
	return style.Render(label)
}
```

- [ ] **Step 5 — Write `components/compactioncard_test.go`**

```go
package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestCompactionCardRendersTokenDeltas(t *testing.T) {
	out := RenderCompactionCard(1000, 500, "abc12345", theme.Dark(), 80)
	for _, want := range []string{"1000", "500", "abc12345", "compacted"} {
		if !strings.Contains(out, want) {
			t.Errorf("compaction card missing %q: %q", want, out)
		}
	}
}

func TestCompactionCardSmallWidthFallsBackToPlain(t *testing.T) {
	out := RenderCompactionCard(1000, 500, "abc12345", theme.Dark(), 3)
	if !strings.Contains(out, "compacted") {
		t.Errorf("small-width fallback missing 'compacted': %q", out)
	}
}
```

- [ ] **Step 6 — Wire goodbye + compaction in app.go**

In `Model`, add:

```go
goodbyeSummary *transport.SessionSummary // M9 T7 — non-nil after session_summary event
```

In `handleEvent`, add cases:

```go
case "session_summary":
	ss, err := transport.DecodeSessionSummary(env.Raw)
	if err != nil {
		return
	}
	m.goodbyeSummary = &ss
```

Update the existing `compaction_complete` case to use the new card:

```go
case "compaction_complete":
	cc, err := transport.DecodeCompactionComplete(env.Raw)
	if err != nil {
		return
	}
	m.clearThinkingIfPending()
	m.sessionID = cc.ActiveSessionID
	m.transcript.AppendLine(components.RenderCompactionCard(
		cc.EstimatedBeforeTokens,
		cc.EstimatedAfterTokens,
		shortSessionID(cc.ActiveSessionID),
		m.theme,
		m.width,
	))
```

In `View()`, before the existing transcript+prompt+statusLine composition, add an early return when `goodbyeSummary != nil`:

```go
if m.goodbyeSummary != nil {
	return components.RenderGoodbye(*m.goodbyeSummary, m.theme, m.width, m.height)
}
```

(The goodbye card replaces the full view when active; the TUI is about to exit anyway.)

Add the import for `transport.SessionSummary` if missing.

- [ ] **Step 7 — Test + build**

```bash
cd packages/tui && go test ./... -v
go build ./...
```

- [ ] **Step 8 — Commit**

```
git add packages/tui/internal/components/goodbye.go packages/tui/internal/components/goodbye_test.go packages/tui/internal/components/compactioncard.go packages/tui/internal/components/compactioncard_test.go packages/tui/internal/transport/types.go packages/tui/internal/app/app.go
git commit -m "feat(tui): M9 T7 — goodbye card + compaction marker + SessionSummary Go mirror (closes #39)"
git push origin master
```

---

## Task 8: Slash autocomplete popup

**Goal:** New `components/slashautocomplete.go` — popup overlay that appears when prompt input starts with `/`. Fuzzy-matches against a static list of slash commands plus the cached skills (M8 T6). Tab completes the highlighted entry; Esc dismisses; Up/Down navigates; Enter dispatches.

**Files:**
- Create: `packages/tui/internal/components/slashautocomplete.go`, `slashautocomplete_test.go`
- Modify: `packages/tui/internal/components/prompt.go` (expose current text for `/` detection)
- Modify: `packages/tui/internal/app/app.go` (manage autocomplete state on each KeyMsg)

### Steps

- [ ] **Step 1 — Define the slash command list**

The TUI has these slash commands wired today (per app.go intercepts):
- `/compact` (M6 T6)
- `/expand [N]` (M8 T6)
- `/theme <name>` (M9 T1)
- `/skillname args` (M8 T6 — dynamically populated from m.skills)
- `/quit`, `/exit` (assumed; verify in app.go — if not present, popup still shows them as documented options)

Static list lives inside `slashautocomplete.go` as:

```go
type Entry struct {
	Name        string
	Description string
}

var staticEntries = []Entry{
	{"/compact", "summarize prior turns and start a child session"},
	{"/expand", "re-render the Nth-most-recent tool block expanded"},
	{"/theme", "switch between light and dark themes"},
	{"/quit", "exit the TUI"},
	{"/exit", "exit the TUI (alias for /quit)"},
}
```

- [ ] **Step 2 — Write `components/slashautocomplete.go`**

```go
// Package components — SlashAutocomplete: popup overlay shown when the
// prompt input starts with `/`. Fuzzy-matches against static slash commands
// + the cached skills (M8 T6). M9 T8.
//
// Architecture (ADR M9-05): cache fetched at boot via the M8 T6 skill
// hydration; static command list is compile-time. Invalidation deferred —
// the popup's fuzzy matcher tolerates a slightly stale skill cache.
package components

import (
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

type SlashAutocomplete struct {
	visible  bool
	filter   string
	selected int
	matches  []Entry
	theme    theme.Theme
	skills   []transport.Skill
}

func NewSlashAutocomplete(t theme.Theme) SlashAutocomplete {
	return SlashAutocomplete{theme: t}
}

func (s *SlashAutocomplete) SetSkills(skills []transport.Skill) {
	s.skills = skills
}

func (s *SlashAutocomplete) SetTheme(t theme.Theme) {
	s.theme = t
}

// Visible reports whether the popup should be rendered. Set by SetFilter to
// true on non-empty filter (input must start with `/`) and false on empty.
func (s SlashAutocomplete) Visible() bool { return s.visible }

// SetFilter updates the popup state from the current prompt text. Caller
// passes the raw prompt content; the popup detects whether it starts with
// `/`, updates filter + matches, and toggles visibility.
func (s *SlashAutocomplete) SetFilter(promptText string) {
	if !strings.HasPrefix(promptText, "/") {
		s.visible = false
		s.filter = ""
		s.matches = nil
		s.selected = 0
		return
	}
	s.visible = true
	s.filter = promptText
	s.matches = s.compute()
	if s.selected >= len(s.matches) {
		s.selected = 0
	}
}

// MoveDown / MoveUp cycle through matches with bounds clamp.
func (s *SlashAutocomplete) MoveDown() {
	if s.selected+1 < len(s.matches) {
		s.selected++
	}
}

func (s *SlashAutocomplete) MoveUp() {
	if s.selected > 0 {
		s.selected--
	}
}

// Completion returns the name that the prompt should be replaced with on
// Tab. Includes the leading `/`. Returns empty when no matches.
func (s SlashAutocomplete) Completion() string {
	if len(s.matches) == 0 {
		return ""
	}
	return s.matches[s.selected].Name
}

// Dismiss hides the popup without affecting the prompt text.
func (s *SlashAutocomplete) Dismiss() {
	s.visible = false
}

// compute filters the entry list (static + skills) by the filter string.
// Fuzzy match: case-insensitive prefix on the part after `/`.
func (s SlashAutocomplete) compute() []Entry {
	q := strings.TrimPrefix(s.filter, "/")
	q = strings.ToLower(q)
	all := make([]Entry, 0, len(staticEntries)+len(s.skills))
	all = append(all, staticEntries...)
	for _, sk := range s.skills {
		all = append(all, Entry{
			Name:        "/" + sk.Name,
			Description: sk.Description,
		})
	}
	var matches []Entry
	for _, e := range all {
		name := strings.TrimPrefix(e.Name, "/")
		if q == "" || strings.HasPrefix(strings.ToLower(name), q) {
			matches = append(matches, e)
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return matches[i].Name < matches[j].Name
	})
	if len(matches) > 10 {
		matches = matches[:10]
	}
	return matches
}

// View renders the popup above the prompt row. width is the prompt's width.
func (s SlashAutocomplete) View(width int) string {
	if !s.visible || len(s.matches) == 0 {
		return ""
	}
	var lines []string
	for i, m := range s.matches {
		nameStyle := lipgloss.NewStyle().Foreground(s.theme.Primary)
		descStyle := lipgloss.NewStyle().Foreground(s.theme.Dim)
		if i == s.selected {
			nameStyle = nameStyle.Background(s.theme.Border)
			descStyle = descStyle.Background(s.theme.Border)
		}
		line := nameStyle.Render(m.Name) + "  " + descStyle.Render(m.Description)
		lines = append(lines, line)
	}
	body := strings.Join(lines, "\n")
	box := s.theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(body)
}
```

- [ ] **Step 3 — Write `components/slashautocomplete_test.go`**

```go
package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

func TestSlashAutocompleteHiddenByDefault(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	if s.Visible() {
		t.Error("autocomplete should be hidden when no filter set")
	}
}

func TestSlashAutocompleteVisibleOnSlashInput(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	if !s.Visible() {
		t.Error("autocomplete should be visible when input starts with /")
	}
}

func TestSlashAutocompleteHiddenOnNonSlashInput(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	s.SetFilter("hello")
	if s.Visible() {
		t.Error("autocomplete should hide when input no longer starts with /")
	}
}

func TestSlashAutocompleteFiltersByPrefix(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/com")
	completion := s.Completion()
	if completion != "/compact" {
		t.Errorf("filter /com: got %q want /compact", completion)
	}
}

func TestSlashAutocompleteIncludesCachedSkills(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetSkills([]transport.Skill{
		{Name: "summarize", Description: "summarize the conversation"},
	})
	s.SetFilter("/sum")
	if s.Completion() != "/summarize" {
		t.Errorf("filter /sum with summarize skill: got %q want /summarize", s.Completion())
	}
}

func TestSlashAutocompleteMoveDownBoundsClamp(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	// Move way past the end; selected should clamp.
	for i := 0; i < 100; i++ {
		s.MoveDown()
	}
	if s.Completion() == "" {
		t.Error("after 100 MoveDown, Completion should still return something")
	}
}

func TestSlashAutocompleteMoveUpBoundsClamp(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	s.MoveUp() // already at 0; should clamp
	completion := s.Completion()
	if completion == "" {
		t.Error("MoveUp on first entry should still have a completion")
	}
}

func TestSlashAutocompleteDismissHides(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	s.Dismiss()
	if s.Visible() {
		t.Error("Dismiss should hide the popup")
	}
}

func TestSlashAutocompleteViewRendersMatchedEntries(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/com")
	out := s.View(60)
	if !strings.Contains(out, "/compact") {
		t.Errorf("view should include /compact: %q", out)
	}
}
```

- [ ] **Step 4 — Wire autocomplete into Model + prompt/keys handling**

In `Model`:

```go
autocomplete components.SlashAutocomplete // M9 T8
```

In `New()`:

```go
m.autocomplete = components.NewSlashAutocomplete(theme.Dark())
```

After the skill cache hydrates (in the `skillsFetchedMsg` handler), also:

```go
m.autocomplete.SetSkills(msg.skills)
```

After every keystroke that updates the prompt (in the `KeyMsg` case, after `m.prompt, cmd = m.prompt.Update(msg)`):

```go
m.autocomplete.SetFilter(m.prompt.Value())
```

Add Tab + Up + Down + Esc routing BEFORE the default prompt-update path:

```go
if m.autocomplete.Visible() {
	switch msg.String() {
	case "tab":
		completion := m.autocomplete.Completion()
		if completion != "" {
			m.prompt.SetValue(completion + " ")
			m.autocomplete.Dismiss()
		}
		return m, nil
	case "esc":
		m.autocomplete.Dismiss()
		return m, nil
	case "up":
		m.autocomplete.MoveUp()
		return m, nil
	case "down":
		m.autocomplete.MoveDown()
		return m, nil
	}
}
```

Note: `m.prompt.SetValue(...)` needs to exist; if not, add a setter to `prompt.go`:

```go
func (p *Prompt) SetValue(v string) { p.input.SetValue(v) }
```

In `View()`, prepend the popup above the prompt row when visible:

```go
prompt := m.prompt.View()
if m.autocomplete.Visible() {
	prompt = m.autocomplete.View(m.width) + "\n" + prompt
}
return m.transcript.View() + "\n" + prompt + "\n" + m.statusLine.View()
```

- [ ] **Step 5 — Verify**

```bash
cd packages/tui && go test ./... -v && go build ./...
```

- [ ] **Step 6 — Commit**

```
git add packages/tui/internal/components/slashautocomplete.go packages/tui/internal/components/slashautocomplete_test.go packages/tui/internal/components/prompt.go packages/tui/internal/app/app.go
git commit -m "feat(tui): M9 T8 — slash autocomplete popup with fuzzy matcher + Tab/Esc/Up/Down"
git push origin master
```

---

## Task 9: Mouse wheel scroll

**Goal:** Enable Bubble Tea mouse mode so wheel events scroll the transcript viewport. Click handling deferred to M9.5.

**Files:**
- Modify: `packages/tui/cmd/sov-tui/main.go` (add `tea.WithMouseCellMotion()` to `tea.NewProgram`)
- Modify: `packages/tui/internal/app/app.go` (forward `tea.MouseMsg` to transcript)

### Steps

- [ ] **Step 1 — Locate the program-startup site**

```bash
grep -n 'tea.NewProgram\|p.Run\|app.Run' packages/tui/cmd/sov-tui/main.go
```

Add `tea.WithMouseCellMotion()` to the `tea.NewProgram(...)` call. This enables wheel + click event delivery; click handlers are no-op in M9 v1 per ADR M9-06.

- [ ] **Step 2 — Forward MouseMsg to transcript in app.go's Update**

The bubbles `viewport.Model` natively handles `tea.MouseMsg` events (scroll up = `MouseButtonWheelUp`). Adding the case in Update:

```go
case tea.MouseMsg:
	var cmd tea.Cmd
	m.transcript, cmd = m.transcript.Update(msg)
	return m, cmd
```

The transcript's existing `Update` forwards to `viewport.Model.Update`, which scrolls on wheel events.

- [ ] **Step 3 — Test**

In `internal/app/app_test.go`, add:

```go
func TestApp_MouseWheelScrolls(t *testing.T) {
	m := New("test-session", "")
	m.width = 80
	m.height = 24
	// Update with a WindowSizeMsg first so transcript sizes.
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = updated.(Model)
	// Append enough lines to enable scrolling.
	for i := 0; i < 100; i++ {
		m.transcript.AppendLine("line " + strconv.Itoa(i))
	}
	// Wheel up — should not panic + Should reduce scroll offset.
	updated, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonWheelUp})
	m = updated.(Model)
	// (We only assert no panic; scroll-offset is bubbles-internal.)
	_ = m.View()
}
```

- [ ] **Step 4 — Verify**

```bash
cd packages/tui && go test ./internal/app/... -v && go build ./...
```

- [ ] **Step 5 — Commit**

```
git add packages/tui/cmd/sov-tui/main.go packages/tui/internal/app/app.go packages/tui/internal/app/app_test.go
git commit -m "feat(tui): M9 T9 — mouse wheel scroll (click-to-focus deferred to M9.5)"
git push origin master
```

---

## Task 10: Status-line streaming indicator + live cost

**Goal:** TS side — emit `status_update` SSE events at `usage_delta` points during the stream, throttled to ~100ms; flush final state on `turn_complete`. Go side — extend `statusline.go` to consume `status_update` events, show a spinner when `streaming: true`, and display live cost.

**Files:**
- Modify: `src/server/routes/turns.ts` (emit status_update events on usage_delta + throttle)
- Create: `tests/server/turns.statusUpdate.test.ts` (TS unit test)
- Modify: `packages/tui/internal/components/statusline.go` (theme, spinner, live cost)
- Modify: `packages/tui/internal/app/app.go` (handle `status_update` SSE event → update statusline state)

### Steps

- [ ] **Step 1 — Read existing turns.ts to find usage_delta emission site**

```bash
grep -n 'usage_delta\|usage_delta\|recordTokenUsage\|sendStatusUpdate' src/server/routes/turns.ts
```

The M7 fix added `recordTokenUsage` calls. The status_update emission is a new SSE bus publication on top.

- [ ] **Step 2 — Add `emitStatusUpdate` helper in turns.ts**

Add near the top of `runTurnInBackground` (or as a module-local function), with throttle state per session:

```typescript
const statusUpdateThrottle = new Map<string, { lastEmitMs: number; pending: boolean }>();
const THROTTLE_MS = 100;

function publishStatusUpdate(
  bus: SessionEventBus,
  sessionId: string,
  payload: {
    cost?: number;
    tokensIn?: number;
    tokensOut?: number;
    cacheHitRate?: number;
    streaming?: boolean;
  },
  immediate = false,
): void {
  const now = Date.now();
  const state = statusUpdateThrottle.get(sessionId) ?? { lastEmitMs: 0, pending: false };
  if (!immediate && now - state.lastEmitMs < THROTTLE_MS) {
    state.pending = true;
    statusUpdateThrottle.set(sessionId, state);
    return;
  }
  state.lastEmitMs = now;
  state.pending = false;
  statusUpdateThrottle.set(sessionId, state);
  bus.publish({
    type: 'status_update',
    sessionId,
    seq: bus.nextSeq(),
    ...payload,
  });
}
```

- [ ] **Step 3 — Call `publishStatusUpdate` at usage_delta + on turn_complete**

Locate the point where `query()` emits a `usage_delta` stream event (the route's StreamEvent → SSE mapper). Add:

```typescript
case 'usage_delta':
  // existing recordTokenUsage call site...
  publishStatusUpdate(bus, sessionId, {
    tokensIn: event.usage.input_tokens,
    tokensOut: event.usage.output_tokens,
    streaming: true,
  });
  break;
```

On `turn_complete`, flush:

```typescript
publishStatusUpdate(bus, sessionId, {
  tokensIn: totalIn,
  tokensOut: totalOut,
  streaming: false,
}, true);
statusUpdateThrottle.delete(sessionId);
```

(Implementer: read the actual stream-event names; the exact event name from `query()` may differ — check `src/core/query.ts` for the emitted `StreamEvent` type names.)

- [ ] **Step 4 — Write `tests/server/turns.statusUpdate.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import { buildRuntime } from '../../src/server/runtime.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { MockProvider } from './_helpers/mockProvider.js'; // adjust per existing mock helpers

describe('turns route — status_update event emission (M9 T10)', () => {
  test('emits status_update with streaming:true during turn + streaming:false on completion', async () => {
    const runtime = await buildRuntime({
      cwd: process.cwd(),
      harnessHome: process.cwd(),
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const sessionRes = await app.fetch(new Request('http://localhost/sessions', { method: 'POST', body: '{}' }));
    const { sessionId } = await sessionRes.json();

    const events: any[] = [];
    const eventsPromise = (async () => {
      const sseRes = await app.fetch(new Request(`http://localhost/sessions/${sessionId}/events`));
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value).split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            events.push(JSON.parse(line.slice(6)));
          }
        }
        if (events.some((e) => e.type === 'turn_complete')) break;
      }
    })();

    await app.fetch(new Request(`http://localhost/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    }));

    await eventsPromise;

    const statusEvents = events.filter((e) => e.type === 'status_update');
    expect(statusEvents.length).toBeGreaterThan(0);
    const final = statusEvents[statusEvents.length - 1];
    expect(final.streaming).toBe(false);

    await runtime.dispose();
  });
});
```

(Note: the actual test fixture pattern depends on existing tests in `tests/server/`. The implementer may need to adjust the SSE-reading shape to match the existing helper modules.)

- [ ] **Step 5 — Extend statusline.go**

```go
package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

type StatusLine struct {
	width     int
	Cwd       string
	Profile   string
	Provider  string
	Model     string
	Cost      float64
	CacheHit  float64
	Streaming bool
	TokensIn  int
	TokensOut int
	Theme     theme.Theme
	spinner   int // M9 T10 — spinner frame index (advances on each Tick)
}

func NewStatusLine(t theme.Theme) StatusLine {
	return StatusLine{
		Cwd:      "?",
		Profile:  "default",
		Provider: "?",
		Model:    "?",
		Theme:    t,
	}
}

func (s *StatusLine) SetWidth(w int) {
	s.width = w
}

func (s *StatusLine) SetTheme(t theme.Theme) {
	s.Theme = t
}

func (s *StatusLine) AdvanceSpinner() {
	s.spinner = (s.spinner + 1) % len(spinnerFrames)
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func (s StatusLine) View() string {
	bg := s.Theme.StatusBarStyle().Width(s.width).Padding(0, 1)

	left := fmt.Sprintf("%s  %s  %s",
		s.Cwd,
		s.Profile,
		s.Model,
	)

	right := fmt.Sprintf("$%.4f  cache %.0f%%",
		s.Cost,
		s.CacheHit*100,
	)
	if s.Streaming {
		spin := spinnerFrames[s.spinner]
		right = fmt.Sprintf("%s  %s", spin, right)
	}

	// Lay out left + right with padding between to fill width.
	padding := s.width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if padding < 1 {
		padding = 1
	}
	text := left + lipgloss.NewStyle().Width(padding).Render(" ") + right
	return bg.Render(text)
}
```

- [ ] **Step 6 — Wire status_update consumption in app.go**

In `Model`, the existing `statusLine` field stays but `NewStatusLine` now takes a theme. Update `New()`:

```go
st := components.NewStatusLine(theme.Dark())
```

In `handleEvent`, add:

```go
case "status_update":
	su, err := transport.DecodeStatusUpdate(env.Raw)
	if err != nil {
		return
	}
	m.statusLine.Cost = su.Cost
	m.statusLine.CacheHit = su.CacheHitRate
	m.statusLine.TokensIn = su.TokensIn
	m.statusLine.TokensOut = su.TokensOut
	m.statusLine.Streaming = su.Streaming
```

For the spinner animation, add a periodic `tea.Tick` while streaming:

```go
// In Update, after handling status_update, if streaming, schedule a tick:
case spinnerTickMsg:
	if m.statusLine.Streaming {
		m.statusLine.AdvanceSpinner()
		return m, tea.Tick(100*time.Millisecond, func(time.Time) tea.Msg {
			return spinnerTickMsg{}
		})
	}
	return m, nil
```

Schedule the first tick when `status_update` with `streaming: true` lands:

```go
case "status_update":
	// ... existing code ...
	if su.Streaming && !wasStreaming {
		// Schedule the spinner tick.
		// (Caller of handleEvent must observe this; restructure to return cmd.)
}
```

Note: handleEvent currently is `func (m *Model) handleEvent(env transport.Envelope)` returning no cmd. Refactor lightly so status_update updates trigger a cmd return when starting/stopping streaming. Cleanest: change `handleEvent` signature to return `tea.Cmd`, and the `sseMsg` case in Update batches it.

- [ ] **Step 7 — Verify**

```bash
bun run lint && bun run typecheck && bun test tests/server/turns.statusUpdate.test.ts
cd packages/tui && go test ./... -v && go build ./...
```

- [ ] **Step 8 — Commit**

```
git add src/server/routes/turns.ts tests/server/turns.statusUpdate.test.ts packages/tui/internal/components/statusline.go packages/tui/internal/app/app.go
git commit -m "feat(server,tui): M9 T10 — status_update SSE event + statusline streaming indicator + live cost"
git push origin master
```

---

## Task 11: Cleanup — t.Skip + #29 + #39 verify

**Goal:** Re-enable + fix three `t.Skip`'d tests in `internal/app/app_test.go`. Replace deprecated `lipgloss.Style.Copy()` calls in `components/permission.go` with non-deprecated equivalent (#29). Confirm #39 closes via T7.

**Files:**
- Modify: `packages/tui/internal/app/app_test.go` (re-enable 3 skipped tests; root cause = teatest WaitFor race; fix via deterministic event sequencing)
- Modify: `packages/tui/internal/components/permission.go` (replace `.Copy()` calls; #29)
- Modify: `docs/08-roadmap/backlog/post-phase-13-4.md` (close #29 and #39 in T12, but verify the work landed in T11)

### Steps

- [ ] **Step 1 — Audit Style.Copy() calls**

```bash
grep -n 'Style.Copy\|\.Copy()' packages/tui/internal/components/permission.go
```

Expected output: lines 123, 124 from the read earlier — `bold := yellow.Copy().Bold(true)` and `defaultChoice := bold.Copy().Underline(true)`.

- [ ] **Step 2 — Replace `.Copy()` with `Inherit()` or direct re-construction**

The `.Copy()` method was deprecated because `lipgloss.Style` is value-typed in modern versions — assignment is already a copy. Replace:

```go
yellow := lipgloss.NewStyle().Foreground(lipgloss.Color("#e5c07b"))
bold := yellow.Copy().Bold(true)
dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681"))
defaultChoice := bold.Copy().Underline(true)
```

with:

```go
yellow := lipgloss.NewStyle().Foreground(lipgloss.Color("#e5c07b"))
bold := yellow.Bold(true)
dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681"))
defaultChoice := bold.Underline(true)
```

Each `.Bold(true)` / `.Underline(true)` already returns a new value-typed Style; the `.Copy()` was redundant.

Verify lint clean:

```bash
cd packages/tui && go vet ./internal/components/...
```

- [ ] **Step 3 — Re-enable 3 t.Skip'd tests**

Read `packages/tui/internal/app/app_test.go` and locate the three `t.Skip(...)` calls in `TestApp_rendersTurnErrorVisibly`, `TestApp_showsThinkingIndicatorOnEnter`, `TestApp_thinkingClearedByFirstResponseEvent`.

Root cause per state snapshot: teatest's `WaitFor` polling race — the test waits for a condition that may transiently hold then flip back before the next poll. Fix: drain events synchronously by injecting messages directly into `Update` instead of polling.

For each test, replace the teatest-based pattern with a direct `Update(...)` drive. Example pattern:

```go
func TestApp_rendersTurnErrorVisibly(t *testing.T) {
	m := New("session-1", "")
	m.width = 80; m.height = 24
	// Drive a WindowSizeMsg first.
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Inject a turn_error event.
	turnErrJson := `{"type":"turn_error","seq":1,"sessionId":"session-1","error":"boom","recoverable":true}`
	env := transport.Envelope{Type: "turn_error", Seq: 1, SessionID: "session-1", Raw: json.RawMessage(turnErrJson)}
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	rendered := m.View()
	if !strings.Contains(rendered, "boom") {
		t.Errorf("turn_error not visible in transcript: %q", rendered)
	}
}
```

(The exact fix depends on the test's original shape; the engineer reads the existing test body and follows this pattern. Each previously-skipped test gets a deterministic Update-driven body.)

- [ ] **Step 4 — Verify**

```bash
cd packages/tui && go test ./internal/app/... -v -count=1
```

Expected: no `--- SKIP` lines for the three previously-skipped tests; all 8 tests in `internal/app/` pass (plus any new ones from T9).

- [ ] **Step 5 — Commit**

```
git add packages/tui/internal/components/permission.go packages/tui/internal/app/app_test.go
git commit -m "fix(tui): M9 T11 — lipgloss Style.Copy() cleanup (#29) + re-enable 3 inherited M3 t.Skip'd tests"
git push origin master
```

---

## Task 12: Integration smoke + close-out

**Goal:** Final integration smoke (TS-side wire surface + Go-side Model-level visible surfaces). Update all close-out documentation: state snapshot, CLAUDE.md/AGENTS.md pointers, backlog closures (#29, #39), DECISIONS.md ADRs (M9-01 through M9-12), testing-log.md. Verify the full suite green + lint clean + `sov upgrade` final.

**Files:**
- Create: `tests/server/m9Full.test.ts` (TS smoke)
- Create: `packages/tui/internal/app/m9Full_test.go` (Go smoke)
- Modify: `docs/08-roadmap/backlog/post-phase-13-4.md` (close #29 and #39)
- Modify: `DECISIONS.md` (12 new ADR stubs M9-01 to M9-12)
- Move: `docs/07-history/state/2026-05-16.md` → `docs/07-history/state/archive/2026-05-16.md`
- Create: `docs/07-history/state/2026-05-XX.md` (new close-out snapshot, date = today's commit date)
- Modify: `CLAUDE.md` + `AGENTS.md` (update state-snapshot pointer; byte-identical mirror)
- Append: `docs/06-testing/testing-log.md` (M9 close-out entries)

### Steps

- [ ] **Step 1 — Write `tests/server/m9Full.test.ts` (TS integration smoke)**

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime, type Runtime } from '../../src/server/runtime.js';

let runtime: Runtime;
let app: ReturnType<typeof buildAppWithRuntime>;

beforeAll(async () => {
  runtime = await buildRuntime({
    cwd: process.cwd(),
    harnessHome: process.cwd(),
    provider: 'mock',
    preflight: false,
  });
  app = buildAppWithRuntime(runtime);
});

afterAll(async () => {
  await runtime.dispose();
});

describe('M9 full integration smoke', () => {
  test('status_update SSE event fires during a mock turn', async () => {
    const sessionRes = await app.fetch(new Request('http://localhost/sessions', { method: 'POST', body: '{}' }));
    const { sessionId } = await sessionRes.json();

    const events: any[] = [];
    const eventsPromise = (async () => {
      const sseRes = await app.fetch(new Request(`http://localhost/sessions/${sessionId}/events`));
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('data: ')) {
            events.push(JSON.parse(line.slice(6)));
          }
        }
        if (events.some((e) => e.type === 'turn_complete')) break;
      }
    })();

    await app.fetch(new Request(`http://localhost/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    }));

    await eventsPromise;

    const statusEvents = events.filter((e) => e.type === 'status_update');
    expect(statusEvents.length).toBeGreaterThan(0);
  });

  test('session_summary rich payload preserved on disposal', async () => {
    // (Same shape as the M8 T8 session_summary smoke — duplicate locally
    // so M9 has its own regression pin.)
    expect(true).toBe(true); // placeholder — adapt the m8Full test's session_summary case here
  });
});
```

- [ ] **Step 2 — Write `packages/tui/internal/app/m9Full_test.go` (Go Model smoke)**

```go
package app

import (
	"encoding/json"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

func TestM9_MarkdownRenderedInAssistantText(t *testing.T) {
	m := New("s1", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	td := `{"type":"text_delta","seq":1,"sessionId":"s1","block":0,"text":"**bold**"}`
	env := transport.Envelope{Type: "text_delta", Seq: 1, SessionID: "s1", Raw: json.RawMessage(td)}
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)

	view := m.View()
	if strings.Contains(view, "**bold**") {
		t.Errorf("raw markdown leaked: %q", view)
	}
}

func TestM9_AutocompletePopupAppearsOnSlash(t *testing.T) {
	m := New("s1", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	m = model.(Model)

	if !m.autocomplete.Visible() {
		t.Error("autocomplete popup should be visible after typing /")
	}
}

func TestM9_MouseWheelEventDoesNotPanic(t *testing.T) {
	m := New("s1", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	model, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonWheelUp})
	_ = model.(Model)
	// no assertion — just no panic
}

func TestM9_ThemeSwitchRendersDifferently(t *testing.T) {
	m := New("s1", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	m.transcript.AppendAssistantDelta("hello world")
	darkView := m.View()

	// Send /theme light
	for _, r := range "/theme light" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)

	lightView := m.View()
	if darkView == lightView {
		t.Error("dark and light views should differ in ANSI escapes")
	}
}

func TestM9_GoodbyeCardRendersOnSessionSummary(t *testing.T) {
	m := New("s1", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 40})
	m = model.(Model)

	ss := `{"type":"session_summary","seq":1,"sessionId":"s1","totalDispatched":1,"byAgent":{"review-memory":1},"tokens":{"input":50,"output":100,"estimatedCostUsd":0.001}}`
	env := transport.Envelope{Type: "session_summary", Seq: 1, SessionID: "s1", Raw: json.RawMessage(ss)}
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)

	view := m.View()
	if !strings.Contains(view, "Session summary") {
		t.Errorf("goodbye card not rendered: %q", view)
	}
	if !strings.Contains(view, "$0.0010") {
		t.Errorf("goodbye card missing cost: %q", view)
	}
}
```

- [ ] **Step 3 — Run the full suite**

```bash
# TS side
bun run lint
bun run typecheck
bun test

# Go side
cd packages/tui
go vet ./...
go test ./...
go build ./...
```

Expected: all green; lint shows the existing 2 `noNonNullAssertion` warnings only.

- [ ] **Step 4 — Update `docs/08-roadmap/backlog/post-phase-13-4.md`**

Close items #29 (lipgloss Style.Copy) and #39 (Go mirror for SessionSummaryEvent). Mark them `[CLOSED — M9 — 2026-05-XX]`.

- [ ] **Step 5 — Append ADRs to `DECISIONS.md`**

Add 12 ADR stubs under a `## 2026-05-XX — Phase 16.1 M9 visual polish (ADRs M9-01 to M9-12)` section. Each follows the M8 pattern: one paragraph statement + rationale.

- [ ] **Step 6 — Write the new close-out snapshot**

Move `docs/07-history/state/2026-05-16.md` → `docs/07-history/state/archive/2026-05-16.md`:

```bash
git mv docs/07-history/state/2026-05-16.md docs/07-history/state/archive/2026-05-16.md
```

Write a new `docs/07-history/state/2026-05-XX.md` (close-out date) following the M8 snapshot template — header with HEAD SHA + suite counts + lint/typecheck status, what shipped section per task, ADRs added, what's open/next, behavioral notes, postmortem-rule compliance check, link to next milestone (M10 parity audit).

- [ ] **Step 7 — Update `CLAUDE.md` + `AGENTS.md` state-snapshot pointer**

Search for `2026-05-16.md` references in CLAUDE.md and update to the new snapshot date. Verify byte-identical mirror:

```bash
diff CLAUDE.md AGENTS.md
```

Should print nothing. If they differ, make the AGENTS.md edit identical to CLAUDE.md.

- [ ] **Step 8 — Append to `docs/06-testing/testing-log.md`**

Per the testing-log convention, append newest-first entries for each task. Each entry: date, task, what was tested, pass/fail counts, any bugs surfaced + fixes.

- [ ] **Step 9 — Final `sov upgrade`**

Per `docs/05-conventions/sov-upgrade.md`:

```bash
sov upgrade
sov --version
```

The version string should resolve to `0.1.0-<short-sha>` matching the new HEAD.

- [ ] **Step 10 — Final commit**

```
git add docs/08-roadmap/backlog/post-phase-13-4.md DECISIONS.md CLAUDE.md AGENTS.md docs/07-history/state/2026-05-XX.md docs/07-history/state/archive/2026-05-16.md docs/06-testing/testing-log.md tests/server/m9Full.test.ts packages/tui/internal/app/m9Full_test.go
git commit -m "docs: M9 close-out — 12 ADRs, 2 backlog items closed (#29, #39), state snapshot"
git push origin master
```

---

## Final Verification Checklist

After all 12 tasks land, verify before declaring M9 complete:

- [ ] `bun run lint` clean (only 2 pre-existing warnings in shellSemantics.ts).
- [ ] `bun run typecheck` clean.
- [ ] `bun test` — unit suite 1991+ tests pass; no regressions.
- [ ] `cd packages/tui && go test ./...` — all Go tests pass; 3 inherited M3 t.Skip's re-enabled and passing.
- [ ] `cd packages/tui && go build ./...` — `sov-tui` binary builds.
- [ ] `sov upgrade` — global `~/.bun/bin/sov` matches HEAD.
- [ ] `sov --version` resolves to the new HEAD short-SHA.
- [ ] `diff CLAUDE.md AGENTS.md` is empty.
- [ ] `git diff master -- src/ui/terminalRepl.ts` is empty (Rule 1 verified).
- [ ] `git diff master --diff-filter=D -- src/` is empty (Rule 2 verified).
- [ ] Backlog items #29 + #39 marked CLOSED.
- [ ] ADRs M9-01 through M9-12 in DECISIONS.md.
- [ ] State snapshot at `docs/07-history/state/2026-05-XX.md` exists and is referenced from CLAUDE.md.
- [ ] Testing log entries for each task in `docs/06-testing/testing-log.md`.

---

## Post-M9 Notes (out of scope for this plan)

- **Real-Anthropic visual smoke** — `scripts/m9-real-smoke.ts` (adapt from `scripts/m8-real-smoke.ts`). Cost budget ~$0.005. Separate session; verifies styled cards render correctly against a real Haiku-4.5 turn. M7/M8 precedent.
- **M9.5 follow-up plan** — TOML theme loader, mouse click-to-focus, `--no-mouse` opt-out, additional themes (Tokyo Night, Charm stock).
- **M10 parity audit** — independent audit of `src/ui/terminalRepl.ts` import list per Postmortem Rule 3. Confirms every imported subsystem has a corresponding wiring in the server-mode + TUI surface.
- **M11 default flip** — `--ui tui` becomes default; `--ui repl` remains opt-in. `src/main.ts` `defaultUI` constant flips.
