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
