package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestCodeHighlightsGo(t *testing.T) {
	src := "package main\nfunc main() { println(\"hi\") }"
	out := Code(src, "go", theme.Dark(), 80)
	if out == "" {
		t.Error("Code returned empty for non-empty input")
	}
	// chroma should preserve the words from the source.
	if !strings.Contains(out, "package") {
		t.Errorf("Code dropped content: %q", out)
	}
}

func TestCodeNoLanguageFallsBackToPlain(t *testing.T) {
	out := Code("hello", "", theme.Dark(), 80)
	if !strings.Contains(out, "hello") {
		t.Errorf("Code(no language): expected hello in fallback: %q", out)
	}
}

func TestCodeUnknownLanguageFallsBackToPlain(t *testing.T) {
	out := Code("hello", "made-up-lang-9000", theme.Dark(), 80)
	if !strings.Contains(out, "hello") {
		t.Errorf("Code(unknown language): expected plain fallback containing input; got %q", out)
	}
}

func TestCodeEmptyInputReturnsEmpty(t *testing.T) {
	out := Code("", "go", theme.Dark(), 80)
	if out != "" {
		t.Errorf("Code(empty): expected empty, got %q", out)
	}
}

func TestCodeLightThemeRenders(t *testing.T) {
	out := Code("var x = 1", "javascript", theme.Light(), 80)
	if !strings.Contains(out, "x") {
		t.Errorf("Code(light): dropped content: %q", out)
	}
}

// ux-fixes 2026-05-22: dark themes now prefer monokai over catppuccin-mocha
// for code-block syntax highlighting. The Catppuccin palette was rendering
// flat-dim on the user's terminal due to palette quantization (see
// docs/conventions/tui-color-rendering.md for the broader story). Monokai's
// high-contrast colors survive palette mapping more reliably.
func TestChromaStyleForDarkThemeIsMonokai(t *testing.T) {
	style := chromaStyleForTheme(theme.Dark())
	if style == nil {
		t.Fatal("chromaStyleForTheme(Dark): expected non-nil style")
	}
	if style.Name != "monokai" {
		t.Errorf("chromaStyleForTheme(Dark): expected monokai, got %q", style.Name)
	}
}

func TestChromaStyleForLightThemeIsCatppuccinLatte(t *testing.T) {
	// Regression guard: the dark-theme switch must not break the light
	// theme path. Light theme continues to prefer catppuccin-latte.
	style := chromaStyleForTheme(theme.Light())
	if style == nil {
		t.Fatal("chromaStyleForTheme(Light): expected non-nil style")
	}
	if style.Name != "catppuccin-latte" {
		t.Errorf("chromaStyleForTheme(Light): expected catppuccin-latte, got %q", style.Name)
	}
}
