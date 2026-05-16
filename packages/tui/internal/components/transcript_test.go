package components

import (
	"strings"
	"testing"

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
