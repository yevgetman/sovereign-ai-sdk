package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
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
