package components

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestTranscriptNewStartsEmpty(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	// View() should not panic on empty content.
	_ = tr.View()
}

func TestTranscriptAppendLineAddsContent(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendLine("hello world")
	if !strings.Contains(tr.View(), "hello world") {
		t.Errorf("AppendLine: expected content in view: %q", tr.View())
	}
}

func TestTranscriptPageUpScrollsView(t *testing.T) {
	// ux-fixes round 4 regression test — PgUp must shift the viewport
	// window so an earlier line becomes visible. Pre-fix the viewport
	// either didn't receive the key or the sizing kept content
	// fully visible (vp.Height == contentHeight), masking scroll.
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 5) // 5-row viewport — small enough to force overflow.
	for i := 0; i < 30; i++ {
		tr.AppendLine("line-" + itoa(i))
	}
	// Initially scrolled to bottom — line-29 visible, line-0 not.
	viewAtBottom := tr.View()
	if !strings.Contains(viewAtBottom, "line-29") {
		t.Fatalf("expected line-29 at bottom; got: %q", viewAtBottom)
	}
	// Page up via the viewport keymap (pgup is bound by default).
	updated, _ := tr.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	viewAfterPgUp := updated.View()
	if viewAfterPgUp == viewAtBottom {
		t.Errorf("PgUp produced no scroll change; before=%q after=%q", viewAtBottom, viewAfterPgUp)
	}
}

// itoa is a tiny strconv-free decimal helper so transcript tests stay
// dependency-light.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func TestTranscriptAppendAssistantDeltaRendersMarkdown(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendAssistantDelta("**bold**")
	// glamour transforms — the raw "**bold**" literal should not survive.
	rendered := tr.View()
	if strings.Contains(rendered, "**bold**") {
		t.Errorf("AppendAssistantDelta: raw markdown leaked into rendered view: %q", rendered)
	}
	// But the word "bold" should be present.
	if !strings.Contains(rendered, "bold") {
		t.Errorf("AppendAssistantDelta: lost content: %q", rendered)
	}
}

func TestTranscriptAppendAssistantDeltaAccumulates(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendAssistantDelta("hello ")
	tr.AppendAssistantDelta("world")
	rendered := tr.View()
	if !strings.Contains(rendered, "hello") || !strings.Contains(rendered, "world") {
		t.Errorf("AppendAssistantDelta: deltas not accumulated: %q", rendered)
	}
}

func TestTranscriptEndAssistantCardStartsNewCardOnNextDelta(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendAssistantDelta("first")
	tr.EndAssistantCard()
	tr.AppendAssistantDelta("second")
	rendered := tr.View()
	if !strings.Contains(rendered, "first") || !strings.Contains(rendered, "second") {
		t.Errorf("EndAssistantCard: cards merged or content lost: %q", rendered)
	}
}

func TestTranscriptSetThemeReRendersCurrentCard(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendAssistantDelta("# Heading")
	tr.SetTheme(theme.Light())
	// Both light and dark themes should preserve the heading text.
	if !strings.Contains(tr.View(), "Heading") {
		t.Errorf("SetTheme: heading content lost: %q", tr.View())
	}
}

func TestTranscriptAppendLineFinalizesCurrentCard(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendAssistantDelta("streamed")
	tr.AppendLine("interrupt")
	tr.AppendAssistantDelta("next-card")
	rendered := tr.View()
	if !strings.Contains(rendered, "streamed") || !strings.Contains(rendered, "interrupt") || !strings.Contains(rendered, "next-card") {
		t.Errorf("AppendLine: did not preserve all content: %q", rendered)
	}
}

func TestTranscriptRemoveLastLineWorksWithStreamingCard(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 20)
	tr.AppendLine("keep me")
	tr.AppendAssistantDelta("remove me")
	tr.RemoveLastLine()
	rendered := tr.View()
	if !strings.Contains(rendered, "keep me") {
		t.Errorf("RemoveLastLine: lost preceding content: %q", rendered)
	}
}

// M9.6 T1 — mouse click resolution + card-toggle helpers.

func TestTranscriptClickAtResolvesToolCard(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 24)
	tr.AppendLineAsCard(ToolCard{Tool: "Bash", Summary: "ok", Theme: theme.Dark()})
	// The single tool card occupies the first few lines (border + body).
	// Y=0 must hit it.
	idx, ok := tr.ClickAt(0)
	if !ok {
		t.Error("ClickAt(0) should resolve to the card line")
	}
	if idx != 0 {
		t.Errorf("ClickAt(0): got lineIdx=%d want 0", idx)
	}
}

func TestTranscriptClickAtBelowLastLineReturnsFalse(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 24)
	tr.AppendLine("just one line")
	_, ok := tr.ClickAt(100)
	if ok {
		t.Error("ClickAt past the last line should return false")
	}
}

func TestTranscriptClickAtNegativeYReturnsFalse(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 24)
	tr.AppendLine("anything")
	_, ok := tr.ClickAt(-5)
	if ok {
		t.Error("ClickAt(negative) should return false")
	}
}

func TestTranscriptToggleCardExpandedFlipsState(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 24)
	card := ToolCard{
		Tool:    "Bash",
		Summary: "collapsed-view-text",
		Output:  "expanded-view-text",
		Theme:   theme.Dark(),
	}
	tr.AppendLineAsCard(card)
	initial := tr.View()
	if !strings.Contains(initial, "collapsed-view-text") {
		t.Errorf("initial render should show summary: %q", initial)
	}
	if strings.Contains(initial, "expanded-view-text") {
		t.Errorf("initial render should NOT show output: %q", initial)
	}
	tr.ToggleCardExpanded(0)
	expanded := tr.View()
	if !strings.Contains(expanded, "expanded-view-text") {
		t.Errorf("expanded render should show output: %q", expanded)
	}
}

func TestTranscriptToggleCardExpandedNoOpOnUnknownIdx(t *testing.T) {
	tr := NewTranscript(theme.Dark())
	tr.SetSize(80, 24)
	tr.AppendLine("not a card")
	// Should not panic.
	tr.ToggleCardExpanded(0)
	tr.ToggleCardExpanded(999)
}
