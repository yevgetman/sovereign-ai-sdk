# Phase 16.1 M9.5 — Theme Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent model policy: Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; never Haiku (see `docs/05-conventions/subagent-policy.md`).

**Goal:** Complete the M9 theme system. Four tasks ship a TOML loader for user themes (`~/.harness/themes/*.toml`), add 2 more bundled palettes (Tokyo Night Storm + Sovereign brand-aligned), and persist `/theme` choices to `~/.harness/config.json` so they survive restart.

**Architecture:** All work Go-side under `packages/tui/internal/theme/` plus minimal extensions in `packages/tui/internal/app/app.go` (boot read + slash write). Zero TS-side changes. Constructor-injection pattern from M9 preserved; theme.Resolve stays pure (built-ins only); a separate `theme.LoadFromFile` does filesystem work.

**Tech Stack:** Go 1.24 / `github.com/BurntSushi/toml` (new dep — pure Go, ~50KB) / existing lipgloss + bubbletea + bubbles stack.

**Spec references:**
- `specs/2026-05-16-phase-16-1-m9-5-theme-polish-design.md` (the spec this plan implements)
- `specs/2026-05-16-phase-16-1-m9-visual-polish-design.md` §ADR M9-03 (TOML loader deferral being closed)
- `docs/07-history/state/2026-05-16.md` §"What does NOT work" (M9.5 scope source)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4

**Scope guard — what M9.5 does NOT do:**
- **No mouse click handling.** Wheel-only stays through M9.5; click is later.
- **No `--no-mouse` flag.**
- **No `stall_detected` visual badge.**
- **No `/skills reload` slash.**
- **No autocomplete cache invalidation on `compaction_complete`.**
- **No real-Anthropic visual smoke** (separate session).
- **No terminalRepl changes** (Postmortem Rule 1 — binding through M11).
- **No hex string validation** in TOML loader (TODO for a later milestone).

---

## Inline Decisions (ADRs M9.5-01 through M9.5-03, locked at spec)

| Decision | Resolution |
|---|---|
| **M9.5-01** TOML schema | Flat snake_case in TOML → camelCase in Go. Built-ins always win by name; TOML can't override `dark` / `light` / `tokyo-night` / `sovereign`. |
| **M9.5-02** Persistence timing | Synchronous best-effort write on `/theme` switch. Read at boot. Failures log to debug + render dim transcript marker. |
| **M9.5-03** Partial TOML | Missing color fields fall back to `Dark()` per-field value. Only the `name` field is mandatory. |

---

## File Structure

### New files

| Path | Responsibility | Approx LoC |
|---|---|---|
| `packages/tui/internal/theme/loader.go` | TOML parse + filesystem lookup; `LoadFromFile(name, dir) (Theme, error)`; partial-file fallback to Dark per-field | ~120 |
| `packages/tui/internal/theme/loader_test.go` | Round-trip full schema, partial schema, malformed TOML, missing file, missing `name` field | ~150 |
| `packages/tui/internal/theme/tokyo-night.go` | Tokyo Night Storm palette | ~50 |
| `packages/tui/internal/theme/tokyo_night_test.go` | Field-population assertions | ~40 |
| `packages/tui/internal/theme/sovereign.go` | Sovereign brand-aligned palette (cool slate + cyan) | ~50 |
| `packages/tui/internal/theme/sovereign_test.go` | Field-population assertions | ~40 |
| `packages/tui/internal/theme/integration_test.go` | T4 close-out — round-trip TOML → config → boot → assert | ~130 |

### Modified files

| Path | Modification |
|---|---|
| `packages/tui/go.mod` + `go.sum` | Add `github.com/BurntSushi/toml` |
| `packages/tui/internal/theme/theme.go` | Extend `Resolve` to include `tokyo-night` and `sovereign` |
| `packages/tui/internal/theme/theme_test.go` | Extend `TestResolveKnownNames` to assert all 4 built-ins |
| `packages/tui/internal/app/app.go` | T3 — boot reads `~/.harness/config.json` `theme` field via Resolve + LoadFromFile fallback; `/theme` slash writes the new name back to config.json |
| `docs/08-roadmap/backlog/post-phase-13-4.md` | T4 — no items to close (M9.5 doesn't close backlog items); note M9.5 completion in narrative if relevant |
| `DECISIONS.md` | T4 — add ADRs M9.5-01, M9.5-02, M9.5-03 |
| `docs/07-history/state/2026-05-16.md` | T4 — supersede with M9.5 close-out snapshot (move current to archive) |
| `docs/07-history/state/archive/2026-05-16-m9.md` | T4 — archive of the M9 snapshot (rename from current docs/07-history/state/2026-05-16.md) |
| `CLAUDE.md` / `AGENTS.md` | T4 — update state pointer to M9.5 snapshot; byte-identical mirror |
| `docs/06-testing/testing-log.md` | T4 — append M9.5 close-out entry |

---

## Task 1: TOML loader foundation

**Goal:** New `internal/theme/loader.go` that parses a TOML file at `<dir>/<name>.toml` into a `Theme`. Missing color fields fall back to `Dark()` per-field (ADR M9.5-03). The `name` field in TOML overrides the filename-derived name; if absent, the filename is used.

**Files:**
- Create: `packages/tui/internal/theme/loader.go`, `loader_test.go`
- Modify: `packages/tui/go.mod`, `go.sum`

### Steps

- [ ] **Step 1 — Add BurntSushi/toml dependency**

```bash
cd packages/tui
go get github.com/BurntSushi/toml@latest
```

Verify it appears in `go.mod` `require` block.

- [ ] **Step 2 — Write `internal/theme/loader.go`**

```go
// Package theme — TOML loader for user-defined themes (M9.5 ADR M9.5-01).
//
// User themes live at <harnessHome>/themes/<name>.toml. The schema is flat
// snake_case in TOML and maps to camelCase Go fields via BurntSushi/toml's
// struct-tag-driven decoder. Missing color fields fall back to Dark() per
// field (ADR M9.5-03), so a 3-color TOML still produces a valid theme.

package theme

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/charmbracelet/lipgloss"
)

// tomlTheme is the on-disk shape. Optional fields use string + post-parse
// merging against Dark() so we can distinguish "field absent" (string == "")
// from "field set to empty" (which would be a malformed hex anyway).
type tomlTheme struct {
	Name   string      `toml:"name"`
	Colors tomlColors  `toml:"colors"`
}

type tomlColors struct {
	Background     string `toml:"background"`
	Foreground     string `toml:"foreground"`
	Dim            string `toml:"dim"`
	Border         string `toml:"border"`
	Primary        string `toml:"primary"`
	Success        string `toml:"success"`
	Warning        string `toml:"warning"`
	Error          string `toml:"error"`
	Info           string `toml:"info"`
	CodeBackground string `toml:"code_background"`
	DiffAdded      string `toml:"diff_added"`
	DiffRemoved    string `toml:"diff_removed"`
	DiffContext    string `toml:"diff_context"`
}

// LoadFromFile parses <dir>/<name>.toml into a Theme. Per ADR M9.5-03, missing
// color fields fall back to Dark()'s value. Returns os.ErrNotExist (wrapped)
// when the file doesn't exist so callers can distinguish "no theme by that
// name" from "theme is broken".
func LoadFromFile(name, dir string) (Theme, error) {
	if name == "" {
		return Theme{}, fmt.Errorf("theme name is empty")
	}
	path := filepath.Join(dir, name+".toml")
	data, err := os.ReadFile(path)
	if err != nil {
		return Theme{}, fmt.Errorf("read theme file %s: %w", path, err)
	}
	var parsed tomlTheme
	if _, err := toml.Decode(string(data), &parsed); err != nil {
		return Theme{}, fmt.Errorf("parse theme file %s: %w", path, err)
	}
	if parsed.Name == "" {
		// Per ADR M9.5-03, name is mandatory. The filename is a hint but the
		// theme's self-declared identity is what callers persist + display.
		return Theme{}, fmt.Errorf("theme file %s missing required `name` field", path)
	}
	// Merge against Dark() per-field (ADR M9.5-03).
	base := Dark()
	return Theme{
		Name:           parsed.Name,
		Background:     pickColor(parsed.Colors.Background, base.Background),
		Foreground:     pickColor(parsed.Colors.Foreground, base.Foreground),
		Dim:            pickColor(parsed.Colors.Dim, base.Dim),
		Border:         pickColor(parsed.Colors.Border, base.Border),
		Primary:        pickColor(parsed.Colors.Primary, base.Primary),
		Success:        pickColor(parsed.Colors.Success, base.Success),
		Warning:        pickColor(parsed.Colors.Warning, base.Warning),
		Error:          pickColor(parsed.Colors.Error, base.Error),
		Info:           pickColor(parsed.Colors.Info, base.Info),
		CodeBackground: pickColor(parsed.Colors.CodeBackground, base.CodeBackground),
		DiffAdded:      pickColor(parsed.Colors.DiffAdded, base.DiffAdded),
		DiffRemoved:    pickColor(parsed.Colors.DiffRemoved, base.DiffRemoved),
		DiffContext:    pickColor(parsed.Colors.DiffContext, base.DiffContext),
	}, nil
}

func pickColor(parsed string, fallback lipgloss.Color) lipgloss.Color {
	if parsed == "" {
		return fallback
	}
	return lipgloss.Color(parsed)
}
```

- [ ] **Step 3 — Write `internal/theme/loader_test.go`**

```go
package theme

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFromFileFullSchema(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "test-theme"

[colors]
background      = "#000000"
foreground      = "#ffffff"
dim             = "#888888"
border          = "#444444"
primary         = "#00ff00"
success         = "#00aa00"
warning         = "#ffaa00"
error           = "#ff0000"
info            = "#666666"
code_background = "#111111"
diff_added      = "#00ff00"
diff_removed    = "#ff0000"
diff_context    = "#888888"
`
	if err := os.WriteFile(filepath.Join(dir, "test-theme.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("test-theme", dir)
	if err != nil {
		t.Fatalf("LoadFromFile: %v", err)
	}
	if th.Name != "test-theme" {
		t.Errorf("name: got %q want test-theme", th.Name)
	}
	if string(th.Background) != "#000000" {
		t.Errorf("background: got %q", th.Background)
	}
	if string(th.Primary) != "#00ff00" {
		t.Errorf("primary: got %q", th.Primary)
	}
}

func TestLoadFromFilePartialUsesDarkFallback(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "minimal"

[colors]
primary = "#deadbe"
`
	if err := os.WriteFile(filepath.Join(dir, "minimal.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("minimal", dir)
	if err != nil {
		t.Fatalf("LoadFromFile: %v", err)
	}
	if string(th.Primary) != "#deadbe" {
		t.Errorf("primary not applied: %q", th.Primary)
	}
	dark := Dark()
	if th.Background != dark.Background {
		t.Errorf("background not Dark fallback: got %q want %q", th.Background, dark.Background)
	}
	if th.Foreground != dark.Foreground {
		t.Errorf("foreground not Dark fallback: got %q want %q", th.Foreground, dark.Foreground)
	}
}

func TestLoadFromFileMissingNameErrors(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `[colors]
primary = "#ff0000"
`
	if err := os.WriteFile(filepath.Join(dir, "no-name.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := LoadFromFile("no-name", dir)
	if err == nil {
		t.Error("expected error for missing name field")
	}
}

func TestLoadFromFileMalformedErrors(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "broken.toml"), []byte("this is not valid toml ===="), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := LoadFromFile("broken", dir)
	if err == nil {
		t.Error("expected error for malformed TOML")
	}
}

func TestLoadFromFileMissingFileErrors(t *testing.T) {
	dir := t.TempDir()
	_, err := LoadFromFile("nonexistent", dir)
	if err == nil {
		t.Error("expected error for missing file")
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("expected os.ErrNotExist wrapped, got %v", err)
	}
}

func TestLoadFromFileEmptyNameErrors(t *testing.T) {
	_, err := LoadFromFile("", t.TempDir())
	if err == nil {
		t.Error("expected error for empty name")
	}
}
```

- [ ] **Step 4 — Build + test**

```bash
cd packages/tui && go test ./internal/theme/... -v -run TestLoadFromFile
go build ./...
```

Expected: all 6 loader tests pass; build clean.

- [ ] **Step 5 — Commit**

```bash
git add packages/tui/go.mod packages/tui/go.sum packages/tui/internal/theme/loader.go packages/tui/internal/theme/loader_test.go
git commit -m "feat(tui): M9.5 T1 — TOML theme loader (BurntSushi/toml; partial-file Dark fallback)"
git push origin master
```

---

## Task 2: Tokyo Night + Sovereign palettes

**Goal:** Add `tokyo-night.go` (Tokyo Night Storm) and `sovereign.go` (cool slate + cyan AI-tooling aesthetic) to `internal/theme/`. Extend `Resolve` to include both names.

**Files:**
- Create: `packages/tui/internal/theme/tokyo-night.go`, `tokyo_night_test.go`, `sovereign.go`, `sovereign_test.go`
- Modify: `packages/tui/internal/theme/theme.go` (Resolve), `theme_test.go` (extend)

### Steps

- [ ] **Step 1 — Write `internal/theme/tokyo-night.go`**

```go
package theme

import "github.com/charmbracelet/lipgloss"

// TokyoNight returns the Tokyo Night Storm palette. Free-to-use; widely
// recognized in developer communities. ADR M9.5 spec §3.6 pins the hex codes.
func TokyoNight() Theme {
	return Theme{
		Name:           "tokyo-night",
		Background:     lipgloss.Color("#1a1b26"),
		Foreground:     lipgloss.Color("#c0caf5"),
		Dim:            lipgloss.Color("#565f89"),
		Border:         lipgloss.Color("#2f334d"),
		Primary:        lipgloss.Color("#7aa2f7"),
		Success:        lipgloss.Color("#9ece6a"),
		Warning:        lipgloss.Color("#e0af68"),
		Error:          lipgloss.Color("#f7768e"),
		Info:           lipgloss.Color("#565f89"),
		CodeBackground: lipgloss.Color("#16161e"),
		DiffAdded:      lipgloss.Color("#9ece6a"),
		DiffRemoved:    lipgloss.Color("#f7768e"),
		DiffContext:    lipgloss.Color("#565f89"),
	}
}
```

- [ ] **Step 2 — Write `internal/theme/sovereign.go`**

```go
package theme

import "github.com/charmbracelet/lipgloss"

// Sovereign returns the brand-aligned palette for the Sovereign AI harness.
// Cool slate background + cyan-blue primary; AI-tooling aesthetic.
// GitHub Dark inspired with a cooler primary. ADR M9.5 spec §3.5 pins hex.
func Sovereign() Theme {
	return Theme{
		Name:           "sovereign",
		Background:     lipgloss.Color("#0d1117"),
		Foreground:     lipgloss.Color("#e6edf3"),
		Dim:            lipgloss.Color("#7d8590"),
		Border:         lipgloss.Color("#30363d"),
		Primary:        lipgloss.Color("#58a6ff"),
		Success:        lipgloss.Color("#3fb950"),
		Warning:        lipgloss.Color("#d29922"),
		Error:          lipgloss.Color("#f85149"),
		Info:           lipgloss.Color("#6e7681"),
		CodeBackground: lipgloss.Color("#161b22"),
		DiffAdded:      lipgloss.Color("#3fb950"),
		DiffRemoved:    lipgloss.Color("#f85149"),
		DiffContext:    lipgloss.Color("#7d8590"),
	}
}
```

- [ ] **Step 3 — Extend `Resolve` in theme.go**

```go
func Resolve(name string) (Theme, bool) {
	switch name {
	case "light":
		return Light(), true
	case "dark":
		return Dark(), true
	case "tokyo-night":
		return TokyoNight(), true
	case "sovereign":
		return Sovereign(), true
	default:
		return Dark(), false
	}
}
```

- [ ] **Step 4 — Write tests**

`tokyo_night_test.go`:

```go
package theme

import "testing"

func TestTokyoNightFieldsPopulated(t *testing.T) {
	th := TokyoNight()
	if th.Name != "tokyo-night" {
		t.Errorf("name: got %q want tokyo-night", th.Name)
	}
	if string(th.Background) != "#1a1b26" {
		t.Errorf("background: got %q", th.Background)
	}
	if string(th.Primary) != "#7aa2f7" {
		t.Errorf("primary: got %q", th.Primary)
	}
	if string(th.Foreground) == "" || string(th.Border) == "" {
		t.Error("foreground or border empty")
	}
}

func TestTokyoNightResolvable(t *testing.T) {
	th, ok := Resolve("tokyo-night")
	if !ok {
		t.Error("tokyo-night should resolve")
	}
	if th.Name != "tokyo-night" {
		t.Errorf("name: got %q", th.Name)
	}
}
```

`sovereign_test.go`:

```go
package theme

import "testing"

func TestSovereignFieldsPopulated(t *testing.T) {
	th := Sovereign()
	if th.Name != "sovereign" {
		t.Errorf("name: got %q want sovereign", th.Name)
	}
	if string(th.Background) != "#0d1117" {
		t.Errorf("background: got %q", th.Background)
	}
	if string(th.Primary) != "#58a6ff" {
		t.Errorf("primary: got %q", th.Primary)
	}
	if string(th.Foreground) == "" || string(th.Border) == "" {
		t.Error("foreground or border empty")
	}
}

func TestSovereignResolvable(t *testing.T) {
	th, ok := Resolve("sovereign")
	if !ok {
		t.Error("sovereign should resolve")
	}
	if th.Name != "sovereign" {
		t.Errorf("name: got %q", th.Name)
	}
}
```

- [ ] **Step 5 — Extend `theme_test.go`**

Replace the existing `TestResolveKnownNames` to also assert tokyo-night + sovereign:

```go
func TestResolveKnownNames(t *testing.T) {
	for _, name := range []string{"dark", "light", "tokyo-night", "sovereign"} {
		th, ok := Resolve(name)
		if !ok {
			t.Errorf("Resolve(%q): ok should be true", name)
		}
		if th.Name != name {
			t.Errorf("Resolve(%q).Name: got %q", name, th.Name)
		}
	}
}
```

- [ ] **Step 6 — Verify**

```bash
cd packages/tui && go test ./internal/theme/... -v
```

- [ ] **Step 7 — Commit**

```bash
git add packages/tui/internal/theme/tokyo-night.go packages/tui/internal/theme/tokyo_night_test.go packages/tui/internal/theme/sovereign.go packages/tui/internal/theme/sovereign_test.go packages/tui/internal/theme/theme.go packages/tui/internal/theme/theme_test.go
git commit -m "feat(tui): M9.5 T2 — Tokyo Night + Sovereign palettes (4 built-ins total)"
git push origin master
```

---

## Task 3: Persistence — boot read + /theme write

**Goal:** `app.New()` reads the theme name from `~/.harness/config.json`, tries `Resolve` first then `LoadFromFile`, falls back to `Dark()` final. `/theme <name>` slash handler writes the new name back synchronously after successful resolution.

**Files:**
- Modify: `packages/tui/internal/app/app.go` — boot read + slash write

### Steps

- [ ] **Step 1 — Add config-read + config-write helpers in app.go**

Add near the top of `app/app.go` (or in a new helper file `app/config.go` — choose based on file size; if `app.go` already > 800 lines, extract):

```go
// configFile returns the path to the user's harness config.json. We don't
// import the TS-side config-loader; this is a tiny Go-side reader that
// preserves unknown fields on write.
func configFile(harnessHome string) string {
	return filepath.Join(harnessHome, "config.json")
}

func themesDir(harnessHome string) string {
	return filepath.Join(harnessHome, "themes")
}

// readThemeFromConfig returns the theme name from ~/.harness/config.json's
// `theme` field, or "dark" if the field is missing, the file doesn't exist,
// or the file is unreadable. Never errors — boot must always proceed.
func readThemeFromConfig(harnessHome string) string {
	const defaultName = "dark"
	data, err := os.ReadFile(configFile(harnessHome))
	if err != nil {
		return defaultName
	}
	var parsed struct {
		Theme string `json:"theme"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return defaultName
	}
	if parsed.Theme == "" {
		return defaultName
	}
	return parsed.Theme
}

// writeThemeToConfig persists the active theme name to config.json's `theme`
// field, preserving any other fields already present. Best-effort: failure
// returns an error which app.go surfaces as a dim transcript marker.
// Atomic write: temp file + rename.
func writeThemeToConfig(harnessHome, name string) error {
	path := configFile(harnessHome)
	existing := map[string]any{}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &existing) // preserve fields on parse failure
	}
	existing["theme"] = name
	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// resolveBootTheme picks the active theme at boot. Tries Resolve first (4
// built-ins), then LoadFromFile (TOML user themes), then falls back to Dark.
func resolveBootTheme(name, harnessHome string) (theme.Theme, error) {
	if t, ok := theme.Resolve(name); ok {
		return t, nil
	}
	t, err := theme.LoadFromFile(name, themesDir(harnessHome))
	if err != nil {
		return theme.Dark(), err
	}
	return t, nil
}
```

Add imports as needed: `encoding/json`, `filepath`, `os`.

- [ ] **Step 2 — Update `app.New` to use boot read**

The current code:

```go
defaultTheme := theme.Dark() // M9 T1: default theme; user toggles via /theme
```

Replace with:

```go
// M9.5 T3 — boot read from ~/.harness/config.json. Falls back to Dark if
// the file is missing, malformed, or the named theme is unknown.
harnessHome := os.Getenv("HARNESS_HOME")
if harnessHome == "" {
	if home, _ := os.UserHomeDir(); home != "" {
		harnessHome = filepath.Join(home, ".harness")
	}
}
themeName := readThemeFromConfig(harnessHome)
defaultTheme, themeErr := resolveBootTheme(themeName, harnessHome)
```

Also stash `harnessHome` on the `Model` struct so `/theme` write can use it:

```go
type Model struct {
	// ...existing fields...
	harnessHome string // M9.5 T3 — for theme persistence write site
}
```

And in the Model construction:

```go
m := Model{
	// ...existing fields...
	harnessHome: harnessHome,
	theme:       defaultTheme,
}
```

Handle the boot error: if `themeErr != nil`, queue a dim transcript marker that surfaces after the first WindowSizeMsg. A simple approach: stash the error on the Model and render it on the first frame.

```go
type Model struct {
	// ...
	pendingThemeError error // M9.5 T3 — shown as dim marker once transcript is sized
}
```

In the `WindowSizeMsg` handler:

```go
if m.pendingThemeError != nil {
	m.transcript.AppendLine(m.theme.DimStyle().Render(
		fmt.Sprintf("could not load theme %q: %v (falling back to dark)", themeName, m.pendingThemeError),
	))
	m.pendingThemeError = nil
}
```

(Adjust `themeName` to be captured into the Model if needed; simplest path is to capture both error + name.)

- [ ] **Step 3 — Update `/theme` slash handler to write**

Existing code (locate in `app.go` ENTER handler):

```go
m.theme = newTheme
m.transcript.SetTheme(m.theme)
m.autocomplete.SetTheme(m.theme)
m.statusLine.SetTheme(m.theme)
m.transcript.AppendLine(m.theme.DimStyle().Render("theme: " + name))
return m, nil
```

Becomes:

```go
m.theme = newTheme
m.transcript.SetTheme(m.theme)
m.autocomplete.SetTheme(m.theme)
m.statusLine.SetTheme(m.theme)
// M9.5 T3 — persist the choice to ~/.harness/config.json. Best-effort:
// failure logs a dim marker but doesn't roll back the in-memory switch.
if err := writeThemeToConfig(m.harnessHome, name); err != nil {
	m.transcript.AppendLine(m.theme.DimStyle().Render(
		fmt.Sprintf("could not persist theme: %v", err),
	))
}
m.transcript.AppendLine(m.theme.DimStyle().Render("theme: " + name))
return m, nil
```

Also extend `/theme` to try the TOML loader if Resolve misses:

```go
newTheme, ok := theme.Resolve(name)
if !ok {
	// M9.5 T3 — Resolve miss falls back to LoadFromFile so user-custom themes
	// at ~/.harness/themes/<name>.toml work.
	if t, err := theme.LoadFromFile(name, themesDir(m.harnessHome)); err == nil {
		newTheme = t
		ok = true
	}
}
if !ok {
	m.transcript.AppendLine(m.theme.ErrorStyle().Render("unknown theme: " + name))
	return m, nil
}
```

- [ ] **Step 4 — Add app-level tests**

In `internal/app/app_test.go`, add tests using a temp `HARNESS_HOME`:

```go
func TestApp_BootReadsConfigTheme(t *testing.T) {
	tmpHome := t.TempDir()
	configPath := filepath.Join(tmpHome, "config.json")
	if err := os.WriteFile(configPath, []byte(`{"theme":"tokyo-night"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	old := os.Getenv("HARNESS_HOME")
	t.Setenv("HARNESS_HOME", tmpHome)
	defer t.Setenv("HARNESS_HOME", old)

	m := New("s-cfg", "")
	if m.theme.Name != "tokyo-night" {
		t.Errorf("boot theme: got %q want tokyo-night", m.theme.Name)
	}
}

func TestApp_BootMissingConfigDefaultsToDark(t *testing.T) {
	tmpHome := t.TempDir()
	old := os.Getenv("HARNESS_HOME")
	t.Setenv("HARNESS_HOME", tmpHome)
	defer t.Setenv("HARNESS_HOME", old)

	m := New("s-nocfg", "")
	if m.theme.Name != "dark" {
		t.Errorf("missing config: got %q want dark", m.theme.Name)
	}
}

func TestApp_ThemeSwitchWritesConfig(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-write", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Type "/theme light" + ENTER.
	for _, r := range "/theme light" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)

	data, err := os.ReadFile(filepath.Join(tmpHome, "config.json"))
	if err != nil {
		t.Fatalf("config.json not written: %v", err)
	}
	if !strings.Contains(string(data), `"theme"`) || !strings.Contains(string(data), "light") {
		t.Errorf("config.json missing theme:light — %q", string(data))
	}
}

func TestApp_BootLoadsTomlTheme(t *testing.T) {
	tmpHome := t.TempDir()
	themesDirPath := filepath.Join(tmpHome, "themes")
	if err := os.MkdirAll(themesDirPath, 0o755); err != nil {
		t.Fatal(err)
	}
	tomlContent := `name = "neon"

[colors]
primary = "#ff00ff"
`
	if err := os.WriteFile(filepath.Join(themesDirPath, "neon.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(tmpHome, "config.json")
	if err := os.WriteFile(configPath, []byte(`{"theme":"neon"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-toml", "")
	if m.theme.Name != "neon" {
		t.Errorf("toml theme: got %q want neon", m.theme.Name)
	}
	if string(m.theme.Primary) != "#ff00ff" {
		t.Errorf("toml primary not applied: %q", m.theme.Primary)
	}
}
```

- [ ] **Step 5 — Verify**

```bash
cd packages/tui && go test -timeout 30s ./internal/app/... -v -run TestApp_Boot
go test -timeout 30s ./... 
```

- [ ] **Step 6 — Commit**

```bash
git add packages/tui/internal/app/app.go packages/tui/internal/app/app_test.go
git commit -m "feat(tui): M9.5 T3 — theme persistence (boot read + /theme write to ~/.harness/config.json)"
git push origin master
```

---

## Task 4: Integration smoke + close-out

**Goal:** Round-trip integration test (TOML file → config.json → boot → assert palette matches). Close-out documentation: 3 ADRs, state snapshot, CLAUDE.md / AGENTS.md pointer, testing-log entry.

**Files:**
- Create: `packages/tui/internal/theme/integration_test.go`
- Modify: `DECISIONS.md`, `CLAUDE.md`, `AGENTS.md`, `docs/06-testing/testing-log.md`
- Move: `docs/07-history/state/2026-05-16.md` → `docs/07-history/state/archive/2026-05-16-m9.md` (or similar)
- Create: `docs/07-history/state/2026-05-16-m9-5.md` (or replace existing 2026-05-16.md)

### Steps

- [ ] **Step 1 — Write `integration_test.go`**

```go
package theme

import (
	"os"
	"path/filepath"
	"testing"
)

// TestIntegrationTomlRoundTrip writes a custom TOML theme, then loads it back
// via LoadFromFile and asserts each color round-trips correctly. M9.5 T4.
func TestIntegrationTomlRoundTrip(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "round-trip"

[colors]
background      = "#101010"
foreground      = "#f0f0f0"
dim             = "#707070"
border          = "#303030"
primary         = "#0080ff"
success         = "#00c060"
warning         = "#ffaa00"
error           = "#ff4040"
info            = "#606060"
code_background = "#181818"
diff_added      = "#00c060"
diff_removed    = "#ff4040"
diff_context    = "#707070"
`
	if err := os.WriteFile(filepath.Join(dir, "round-trip.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("round-trip", dir)
	if err != nil {
		t.Fatalf("LoadFromFile: %v", err)
	}

	tests := []struct {
		name string
		got  string
		want string
	}{
		{"name", th.Name, "round-trip"},
		{"background", string(th.Background), "#101010"},
		{"foreground", string(th.Foreground), "#f0f0f0"},
		{"primary", string(th.Primary), "#0080ff"},
		{"error", string(th.Error), "#ff4040"},
		{"code_background", string(th.CodeBackground), "#181818"},
	}
	for _, tc := range tests {
		if tc.got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, tc.got, tc.want)
		}
	}
}

// TestIntegrationAllBuiltinsResolve guards against a name-typo regression
// in Resolve when adding M9.5+ palettes.
func TestIntegrationAllBuiltinsResolve(t *testing.T) {
	names := []string{"dark", "light", "tokyo-night", "sovereign"}
	for _, n := range names {
		th, ok := Resolve(n)
		if !ok {
			t.Errorf("Resolve(%q): not ok", n)
		}
		if th.Name != n {
			t.Errorf("Resolve(%q).Name: got %q", n, th.Name)
		}
	}
}
```

- [ ] **Step 2 — Run full Go + TS suites**

```bash
cd packages/tui && go test -timeout 30s ./... -count=1
cd /Users/julie/code/sovereign-ai-sdk && bun run lint && bun run typecheck && bun test
```

Expected: all green; lint shows the 2 pre-existing warnings only.

- [ ] **Step 3 — Append ADRs M9.5-01..03 to DECISIONS.md**

Three new ADRs at the bottom:

```
## ADR M9.5-01 — TOML schema flat snake_case; built-ins always win
Decision: ...
Rationale: ...
Status: implemented (M9.5 — <T1 commit>).

## ADR M9.5-02 — Theme persistence synchronous best-effort
Decision: ...
Rationale: ...
Status: implemented (M9.5 — <T3 commit>).

## ADR M9.5-03 — Partial TOML uses Dark per-field fallback
Decision: ...
Rationale: ...
Status: implemented (M9.5 — <T1 commit>).
```

- [ ] **Step 4 — Move M9 snapshot to archive, write M9.5 snapshot**

```bash
git mv docs/07-history/state/2026-05-16.md docs/07-history/state/archive/2026-05-16-m9.md
```

Write new `docs/07-history/state/2026-05-16.md` covering M9.5: HEAD SHA, suite counts, what shipped per task, ADRs, behavioral notes, postmortem-rule check, what's open / next.

- [ ] **Step 5 — Update CLAUDE.md + AGENTS.md state-snapshot pointer**

Change `Phase 16.1 M9 shipped 2026-05-16` to `Phase 16.1 M9.5 shipped 2026-05-16 — theme polish: TOML loader, Tokyo Night + Sovereign palettes, ~/.harness/config.json persistence`. Keep CLAUDE.md / AGENTS.md byte-identical.

- [ ] **Step 6 — Append M9.5 testing-log entry**

Per the testing-log convention, newest-first entry covering scope + suite delta + ADRs + any mid-build bug catches.

- [ ] **Step 7 — Final `sov upgrade`**

```bash
sov upgrade
sov --version  # should resolve to 0.1.0-<short-sha>
```

- [ ] **Step 8 — Final commit + push**

```bash
git add packages/tui/internal/theme/integration_test.go DECISIONS.md docs/07-history/state/ CLAUDE.md AGENTS.md docs/06-testing/testing-log.md
git commit -m "docs: M9.5 T4 close-out — 3 ADRs, theme integration smoke, state snapshot"
git push origin master
```

---

## Final Verification Checklist

After all 4 tasks land:

- [ ] `bun run lint` clean (only 2 pre-existing warnings).
- [ ] `bun run typecheck` clean.
- [ ] `bun test` no regressions.
- [ ] `cd packages/tui && go test ./...` all green.
- [ ] `sov upgrade` + `sov --version` resolves to new HEAD.
- [ ] `diff CLAUDE.md AGENTS.md` empty.
- [ ] `git diff master -- src/ui/terminalRepl.ts` empty (Rule 1).
- [ ] `git diff master --diff-filter=D -- src/` empty (Rule 2).
- [ ] ADRs M9.5-01..03 in DECISIONS.md.
- [ ] State snapshot at `docs/07-history/state/2026-05-16.md` covers M9.5.
- [ ] Testing-log entry for M9.5.

---

## Post-M9.5 Notes (out of scope for this plan)

- **M9.6 candidates** — mouse click handling (focus + collapse), `--no-mouse` opt-out, `stall_detected` visual badge, `/skills reload` slash, autocomplete cache invalidation on `compaction_complete`, hex string validation in TOML loader.
- **Real-Anthropic visual smoke** — `scripts/m9-real-smoke.ts` adapted from `m8-real-smoke.ts`. Budget ~$0.005; separate session.
- **M10 parity audit** — independent audit of `src/ui/terminalRepl.ts` import list per Postmortem Rule 3.
