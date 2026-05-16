// Package theme — M9.5 T4 integration smoke.
//
// End-to-end round-trip: write a custom TOML theme on disk, load it back
// via LoadFromFile, and assert every color field round-trips correctly.
// Also pins the full set of built-in themes against Resolve so a typo in
// the switch can't go unnoticed across M9.5+ palette additions.

package theme

import (
	"os"
	"path/filepath"
	"testing"
)

// TestIntegrationTomlRoundTrip writes a custom TOML theme, then loads it
// back via LoadFromFile and asserts each color round-trips correctly.
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

	checks := []struct {
		name string
		got  string
		want string
	}{
		{"name", th.Name, "round-trip"},
		{"background", string(th.Background), "#101010"},
		{"foreground", string(th.Foreground), "#f0f0f0"},
		{"dim", string(th.Dim), "#707070"},
		{"border", string(th.Border), "#303030"},
		{"primary", string(th.Primary), "#0080ff"},
		{"success", string(th.Success), "#00c060"},
		{"warning", string(th.Warning), "#ffaa00"},
		{"error", string(th.Error), "#ff4040"},
		{"info", string(th.Info), "#606060"},
		{"code_background", string(th.CodeBackground), "#181818"},
		{"diff_added", string(th.DiffAdded), "#00c060"},
		{"diff_removed", string(th.DiffRemoved), "#ff4040"},
		{"diff_context", string(th.DiffContext), "#707070"},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s: got %q want %q", c.name, c.got, c.want)
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

// TestIntegrationBuiltinsAlwaysWinAgainstToml — even if a user writes
// a ~/.harness/themes/dark.toml, the built-in `dark` must still resolve
// via Resolve (ADR M9.5-01). LoadFromFile would parse the user file, but
// callers use Resolve first.
func TestIntegrationBuiltinsAlwaysWinAgainstToml(t *testing.T) {
	dir := t.TempDir()
	// User attempts to override the built-in `dark`.
	tomlContent := `name = "dark"

[colors]
primary = "#ff0000"
`
	if err := os.WriteFile(filepath.Join(dir, "dark.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	// Resolve returns the built-in palette regardless of the on-disk file.
	th, ok := Resolve("dark")
	if !ok {
		t.Error("Resolve(dark) should be ok")
	}
	builtinDark := Dark()
	if th.Primary != builtinDark.Primary {
		t.Errorf("Resolve(dark) primary: got %q want %q (built-in wins; TOML must not override)", th.Primary, builtinDark.Primary)
	}
}
