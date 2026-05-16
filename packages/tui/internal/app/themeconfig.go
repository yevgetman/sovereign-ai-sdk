// Package app — theme persistence helpers (M9.5 T3).
//
// The TUI reads the active theme name from ~/.harness/config.json at boot
// and writes it back on every /theme switch. ADR M9.5-02: synchronous
// best-effort writes; failures log a dim transcript marker but don't roll
// back the in-memory switch. The Go-side reader doesn't import the TS
// config-loader — this is a tiny preserve-unknown-fields JSON round-trip.

package app

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

const defaultThemeName = "dark"

// configFile returns the path to the user's harness config.json.
func configFile(harnessHome string) string {
	return filepath.Join(harnessHome, "config.json")
}

// themesDir returns the path to the user-themes directory.
func themesDir(harnessHome string) string {
	return filepath.Join(harnessHome, "themes")
}

// readThemeFromConfig returns the theme name from ~/.harness/config.json's
// `theme` field, or "dark" if the field is missing, the file doesn't exist,
// or the file is unreadable. Never errors — boot must always proceed.
func readThemeFromConfig(harnessHome string) string {
	data, err := os.ReadFile(configFile(harnessHome))
	if err != nil {
		return defaultThemeName
	}
	var parsed struct {
		Theme string `json:"theme"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return defaultThemeName
	}
	if parsed.Theme == "" {
		return defaultThemeName
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
		// Preserve unknown fields on success; on parse failure start fresh.
		_ = json.Unmarshal(data, &existing)
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

// resolveBootTheme picks the active theme at app boot. Tries Resolve first
// (4 built-ins); on miss, tries LoadFromFile (TOML user themes); on second
// miss, falls back to Dark and returns the load error so the caller can
// surface it as a dim marker.
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

// resolveHarnessHome returns the active HARNESS_HOME, preferring the env
// var, falling back to ~/.harness. Returns empty string if neither is
// available — caller treats that as "no persistence" mode.
func resolveHarnessHome() string {
	if env := os.Getenv("HARNESS_HOME"); env != "" {
		return env
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".harness")
}
