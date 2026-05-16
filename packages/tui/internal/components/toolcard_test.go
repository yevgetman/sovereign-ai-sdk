package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestToolCardCollapsedShowsSummary(t *testing.T) {
	tc := ToolCard{
		Tool:    "FileRead",
		Summary: "rendered as text",
		Theme:   theme.Dark(),
	}
	view := tc.View(80)
	if !strings.Contains(view, "FileRead") {
		t.Errorf("collapsed card missing tool name: %q", view)
	}
	if !strings.Contains(view, "rendered as text") {
		t.Errorf("collapsed card missing summary: %q", view)
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

func TestToolCardExpandedWithoutLanguageShowsPlain(t *testing.T) {
	tc := ToolCard{
		Tool:     "Bash",
		Output:   "stdout content",
		Theme:    theme.Dark(),
		Expanded: true,
	}
	view := tc.View(80)
	if !strings.Contains(view, "stdout content") {
		t.Errorf("expanded card missing plain output: %q", view)
	}
}

func TestToolCardRenderHintCodeUsesCodeRenderer(t *testing.T) {
	tc := ToolCard{
		Tool:       "FileRead",
		Output:     "fn main() {}",
		RenderHint: "code",
		Language:   "rust",
		Theme:      theme.Dark(),
		Expanded:   true,
	}
	view := tc.View(80)
	if !strings.Contains(view, "main") {
		t.Errorf("code-hint card missing content: %q", view)
	}
}

func TestToolCardSmallWidthFallsBackToPlainText(t *testing.T) {
	tc := ToolCard{Tool: "X", Summary: "Y", Theme: theme.Dark()}
	view := tc.View(3)
	if !strings.Contains(view, "[X]") {
		t.Errorf("narrow-width fallback missing [X]: %q", view)
	}
	if !strings.Contains(view, "Y") {
		t.Errorf("narrow-width fallback missing summary: %q", view)
	}
}

func TestToolCardZeroThemeDoesNotPanic(t *testing.T) {
	tc := ToolCard{Tool: "x", Summary: "y"}
	_ = tc.View(80)
}

func TestToolCardLightThemeRenders(t *testing.T) {
	tc := ToolCard{
		Tool:    "FileRead",
		Summary: "ok",
		Theme:   theme.Light(),
	}
	view := tc.View(80)
	if !strings.Contains(view, "FileRead") {
		t.Errorf("light theme card missing tool name: %q", view)
	}
}
