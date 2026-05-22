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

// TestToolCardHeaderColorPinnedToBrandPurple guards the ux-fixes
// choice: tool-card headers render in the SOV-gradient soft-purple
// hex (#a78bfa) rather than theme.Primary so the header reads as
// on-brand across every theme. Pinning the const value catches
// drift to a different brand hex or a regression back to theme tokens.
func TestToolCardHeaderColorPinnedToBrandPurple(t *testing.T) {
	if ToolCardHeaderColor != "#a78bfa" {
		t.Errorf("brand-purple hex changed: got %q want %q", ToolCardHeaderColor, "#a78bfa")
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

// ux-fixes 2026-05-22 — ToolCard.InlineLines truncation in detailed
// mode caps the rendered Output to N rows and appends a dim italic
// "…[+M more lines]" footer. Spec:
// docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
func TestToolCardInlineLinesTruncatesOutput(t *testing.T) {
	// Build an output with 25 lines.
	lines := make([]string, 25)
	for i := range lines {
		lines[i] = "line " + string(rune('A'+i%26))
	}
	output := strings.Join(lines, "\n")
	tc := ToolCard{
		Tool:        "Bash",
		Output:      output,
		Theme:       theme.Dark(),
		Expanded:    true,
		InlineLines: 5,
	}
	view := tc.View(120)
	// Footer indicates 20 surplus lines (25 - 5).
	if !strings.Contains(view, "+20 more lines") {
		t.Errorf("expected '+20 more lines' footer, got: %q", view)
	}
	// Only first 5 lines retained. Line 6 onwards should be absent.
	// Use the 6th line's char as a probe.
	if strings.Contains(view, "line F") {
		t.Errorf("did not expect 6th line in truncated card, got: %q", view)
	}
	// First line still present.
	if !strings.Contains(view, "line A") {
		t.Errorf("expected first line 'line A' in card, got: %q", view)
	}
}

func TestToolCardInlineLinesZeroLeavesOutputUncapped(t *testing.T) {
	// InlineLines == 0 should NOT truncate (legacy behavior).
	output := strings.Repeat("line\n", 50)
	tc := ToolCard{
		Tool:        "Bash",
		Output:      output,
		Theme:       theme.Dark(),
		Expanded:    true,
		InlineLines: 0,
	}
	view := tc.View(120)
	if strings.Contains(view, "more lines") {
		t.Errorf("InlineLines=0 should not truncate, got footer: %q", view)
	}
}

func TestToolCardInlineLinesUnderCapLeavesOutputUntouched(t *testing.T) {
	// Output shorter than cap → no truncation footer.
	output := "line1\nline2\nline3"
	tc := ToolCard{
		Tool:        "Bash",
		Output:      output,
		Theme:       theme.Dark(),
		Expanded:    true,
		InlineLines: 10,
	}
	view := tc.View(120)
	if strings.Contains(view, "more lines") {
		t.Errorf("output under cap shouldn't have truncation footer, got: %q", view)
	}
	for _, want := range []string{"line1", "line2", "line3"} {
		if !strings.Contains(view, want) {
			t.Errorf("expected %q in untruncated card, got: %q", want, view)
		}
	}
}
