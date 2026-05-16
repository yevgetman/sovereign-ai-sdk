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
	if string(th.CodeBackground) != "#111111" {
		t.Errorf("code_background: got %q", th.CodeBackground)
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
	if th.Border != dark.Border {
		t.Errorf("border not Dark fallback: got %q want %q", th.Border, dark.Border)
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
	if err := os.WriteFile(filepath.Join(dir, "broken.toml"), []byte("this is = = = not valid"), 0o644); err != nil {
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

// M9.6 T4 — hex validation in pickColor.

func TestLoadFromFileInvalidHexFallsBackPerField(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "mixed-bad"

[colors]
primary    = "not-a-color"
background = "#abcdef"
foreground = "red"
border     = "#ff00ff"
`
	if err := os.WriteFile(filepath.Join(dir, "mixed-bad.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("mixed-bad", dir)
	if err != nil {
		t.Fatalf("LoadFromFile should still succeed with invalid hex: %v", err)
	}
	dark := Dark()
	if th.Primary != dark.Primary {
		t.Errorf("primary should be Dark fallback for invalid hex: got %q", th.Primary)
	}
	if th.Foreground != dark.Foreground {
		t.Errorf("foreground should be Dark fallback for 'red': got %q", th.Foreground)
	}
	if string(th.Background) != "#abcdef" {
		t.Errorf("background should be the valid hex: got %q", th.Background)
	}
	if string(th.Border) != "#ff00ff" {
		t.Errorf("border should be the valid hex: got %q", th.Border)
	}
}

func TestLoadFromFileShortHexAccepted(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "short-hex"

[colors]
primary = "#abc"
`
	if err := os.WriteFile(filepath.Join(dir, "short-hex.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("short-hex", dir)
	if err != nil {
		t.Fatalf("short-hex form should be valid: %v", err)
	}
	if string(th.Primary) != "#abc" {
		t.Errorf("primary: got %q", th.Primary)
	}
}

func TestLoadFromFileUppercaseHexAccepted(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "upper"

[colors]
primary = "#ABCDEF"
`
	if err := os.WriteFile(filepath.Join(dir, "upper.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("upper", dir)
	if err != nil {
		t.Fatalf("uppercase hex should be valid: %v", err)
	}
	if string(th.Primary) != "#ABCDEF" {
		t.Errorf("primary: got %q", th.Primary)
	}
}

func TestLoadFromFileFourCharHexRejected(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "four-char"

[colors]
primary = "#abcd"
`
	if err := os.WriteFile(filepath.Join(dir, "four-char.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("four-char", dir)
	if err != nil {
		t.Fatalf("LoadFromFile should still succeed: %v", err)
	}
	dark := Dark()
	if th.Primary != dark.Primary {
		t.Errorf("4-char hex should be rejected; expected Dark fallback, got %q", th.Primary)
	}
}

func TestLoadFromFileEmptyStringIsFallback(t *testing.T) {
	dir := t.TempDir()
	tomlContent := `name = "empty-str"

[colors]
primary = ""
`
	if err := os.WriteFile(filepath.Join(dir, "empty-str.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	th, err := LoadFromFile("empty-str", dir)
	if err != nil {
		t.Fatalf("LoadFromFile: %v", err)
	}
	dark := Dark()
	if th.Primary != dark.Primary {
		t.Errorf("empty string should be Dark fallback: got %q", th.Primary)
	}
}
