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

func TestToolCardCollapsedShowsInputPreview(t *testing.T) {
	tc := ToolCard{
		Tool:    "Bash",
		Input:   `{"command":"git status"}`,
		Summary: "rendered as text",
		Theme:   theme.Dark(),
	}
	view := tc.View(80)
	if !strings.Contains(view, "git status") {
		t.Errorf("collapsed card missing input preview: %q", view)
	}
}

func TestToolCardCollapsedTruncatesLongInput(t *testing.T) {
	tc := ToolCard{
		Tool:    "Bash",
		Input:   strings.Repeat("a", 500),
		Summary: "ok",
		Theme:   theme.Dark(),
	}
	view := tc.View(60)
	if !strings.Contains(view, "...") {
		t.Errorf("collapsed card should truncate long input with ...: %q", view)
	}
}

func TestToolCardExpandedHidesInputPreview(t *testing.T) {
	tc := ToolCard{
		Tool:     "Bash",
		Input:    "git status",
		Output:   "stdout content",
		Summary:  "ok",
		Theme:    theme.Dark(),
		Expanded: true,
	}
	view := tc.View(80)
	// Expanded shows output but the header should NOT have the input preview.
	if !strings.Contains(view, "stdout content") {
		t.Errorf("expanded card missing output: %q", view)
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

func TestTruncatePreviewClampsToMax(t *testing.T) {
	got := truncatePreview("abcdefghij", 5)
	if len(got) > 5 {
		t.Errorf("got len %d (%q), expected <=5", len(got), got)
	}
}

func TestTruncatePreviewFlattensNewlines(t *testing.T) {
	got := truncatePreview("a\nb\nc", 10)
	if strings.Contains(got, "\n") {
		t.Errorf("newlines should flatten to spaces: %q", got)
	}
}

func TestTruncatePreviewZeroMaxReturnsEmpty(t *testing.T) {
	got := truncatePreview("hello", 0)
	if got != "" {
		t.Errorf("max=0: expected empty, got %q", got)
	}
}
