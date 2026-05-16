package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestMarkdownTransformsInput(t *testing.T) {
	out := Markdown("**hello**", theme.Dark(), 80)
	if out == "" {
		t.Error("Markdown returned empty for non-empty input")
	}
	// glamour transforms the markdown — the rendered output should not
	// contain the raw markdown literal "**hello**".
	if strings.Contains(out, "**hello**") {
		t.Errorf("Markdown should transform; got raw input in: %q", out)
	}
	// But the word "hello" should still be present.
	if !strings.Contains(out, "hello") {
		t.Errorf("Markdown dropped content: %q", out)
	}
}

func TestMarkdownEmptyInputReturnsEmpty(t *testing.T) {
	out := Markdown("", theme.Dark(), 80)
	if out != "" {
		t.Errorf("Markdown(empty): expected empty, got %q", out)
	}
}

func TestMarkdownHeaderPreservesText(t *testing.T) {
	out := Markdown("# Title\n\nbody", theme.Dark(), 80)
	if !strings.Contains(out, "Title") {
		t.Errorf("Markdown header: missing Title text: %q", out)
	}
	if !strings.Contains(out, "body") {
		t.Errorf("Markdown header: missing body text: %q", out)
	}
}

func TestMarkdownLightThemeRenders(t *testing.T) {
	out := Markdown("# Light", theme.Light(), 80)
	if !strings.Contains(out, "Light") {
		t.Errorf("Markdown(light): missing Light text: %q", out)
	}
}
