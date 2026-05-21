// LiveRegion unit tests — pin the contract introduced by the
// ux-fixes-round-5 inline-mode refactor. The transcript is no longer
// a scrollable viewport; LiveRegion owns the bottom-of-screen live
// region that holds the in-flight streaming card + spinner + running-
// command indicator. Anything destined for scrollback flows through
// the model's pendingPrintln queue (tested elsewhere).

package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestLiveRegion_EmptyByDefault(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	if got := l.View(); got != "" {
		t.Errorf("fresh LiveRegion should render empty; got %q", got)
	}
	if l.HasStreaming() {
		t.Error("fresh LiveRegion should not report HasStreaming")
	}
}

func TestLiveRegion_StreamingAccumulates(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("Hello ")
	l.AppendAssistantDelta("world.")
	view := l.View()
	if !strings.Contains(view, "Hello world.") {
		t.Errorf("streaming view should accumulate deltas; got %q", view)
	}
	if !l.HasStreaming() {
		t.Error("HasStreaming should be true with content")
	}
}

func TestLiveRegion_EndAssistantCard_ReturnsRenderedAndClears(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("**bold** text")
	rendered, ok := l.EndAssistantCard()
	if !ok {
		t.Fatal("EndAssistantCard should return ok=true when content was streaming")
	}
	// Glamour renders **bold** → ANSI; the literal markdown should be
	// consumed but the word "bold" preserved.
	if !strings.Contains(rendered, "bold") {
		t.Errorf("rendered card should preserve content; got %q", rendered)
	}
	if strings.Contains(rendered, "**bold**") {
		t.Errorf("rendered card should consume raw markdown; got %q", rendered)
	}
	if l.HasStreaming() {
		t.Error("LiveRegion should be cleared after EndAssistantCard")
	}
	if l.View() != "" {
		t.Errorf("View should be empty after EndAssistantCard; got %q", l.View())
	}
}

func TestLiveRegion_EndAssistantCard_NoOpWhenEmpty(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	_, ok := l.EndAssistantCard()
	if ok {
		t.Error("EndAssistantCard should return ok=false on empty stream")
	}
}

func TestLiveRegion_SpinnerInViewAndCleared(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetSpinner("  ⢀  Thinking...")
	if !strings.Contains(l.View(), "Thinking...") {
		t.Errorf("spinner should appear in View; got %q", l.View())
	}
	l.ClearSpinner()
	if strings.Contains(l.View(), "Thinking...") {
		t.Errorf("spinner should clear via ClearSpinner; got %q", l.View())
	}
}

func TestLiveRegion_RunningCommandIndicator(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetRunningCommand("…running /cost")
	if !strings.Contains(l.View(), "/cost") {
		t.Errorf("running command should appear in View; got %q", l.View())
	}
	l.SetRunningCommand("")
	if strings.Contains(l.View(), "/cost") {
		t.Errorf("running command should clear when set to empty; got %q", l.View())
	}
}

func TestLiveRegion_StreamingAboveSpinner(t *testing.T) {
	// View() composes streaming card BEFORE spinner so the user sees
	// the partial response above the "still thinking" indicator. This
	// matches the pre-refactor visual order.
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("partial response")
	l.SetSpinner("⢀ thinking")
	view := l.View()
	streamIdx := strings.Index(view, "partial response")
	spinnerIdx := strings.Index(view, "thinking")
	if streamIdx == -1 || spinnerIdx == -1 {
		t.Fatalf("both stream and spinner should appear: %q", view)
	}
	if streamIdx > spinnerIdx {
		t.Errorf("streaming card should render ABOVE spinner; stream@%d, spinner@%d", streamIdx, spinnerIdx)
	}
}

func TestLiveRegion_SetThemeAffectsFutureRender(t *testing.T) {
	// Swap to light theme mid-stream; the next View should reflect the
	// new theme's accent. We don't pin ANSI bytes (lipgloss strips in
	// test contexts) — instead, assert the call doesn't crash and the
	// content survives.
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("hello")
	l.SetTheme(theme.Light())
	if !strings.Contains(l.View(), "hello") {
		t.Errorf("content should survive SetTheme; got %q", l.View())
	}
}
