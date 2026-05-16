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

// tomlTheme is the on-disk shape. We decode into strings and post-process
// against Dark() so "field absent" (string == "") survives BurntSushi's
// zero-value handling.
type tomlTheme struct {
	Name   string     `toml:"name"`
	Colors tomlColors `toml:"colors"`
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
		// Per ADR M9.5-03 the `name` field is mandatory. The filename is a
		// hint but the theme's self-declared identity is what callers
		// persist + display.
		return Theme{}, fmt.Errorf("theme file %s missing required `name` field", path)
	}
	// Merge against Dark() per-field (ADR M9.5-03). Users can ship a single
	// `primary = "#deadbe"` TOML and still get a working theme.
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

// pickColor returns the parsed string as a lipgloss.Color when non-empty,
// otherwise the fallback. No hex validation in v1 — lipgloss accepts the
// color verbatim and renders best-effort.
func pickColor(parsed string, fallback lipgloss.Color) lipgloss.Color {
	if parsed == "" {
		return fallback
	}
	return lipgloss.Color(parsed)
}
