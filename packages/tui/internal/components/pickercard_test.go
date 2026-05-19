package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// samplePayload builds a 3-item picker payload reused across most tests.
// Mirrors the shape `/model` (no args) would emit server-side.
func samplePayload(initial int) transport.PickerOpenPayload {
	p := transport.PickerOpenPayload{
		Title:    "Select a model",
		Subtitle: "Pick the model used for the rest of this session.",
		Items: []transport.PickerItem{
			{Label: "claude-opus-4-7", Value: "claude-opus-4-7", Hint: "deepest reasoning"},
			{Label: "claude-sonnet-4-6", Value: "claude-sonnet-4-6", Hint: "balanced"},
			{Label: "claude-haiku-4-5", Value: "claude-haiku-4-5", Hint: "fastest"},
		},
		Initial: initial,
	}
	p.OnSelect.Command = "model"
	return p
}

func TestPickerCard_InitialSelection(t *testing.T) {
	card := NewPickerCard(samplePayload(2), theme.Dark())
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should resolve on a non-empty payload")
	}
	if value != "claude-haiku-4-5" {
		t.Errorf("initial selection: got %q want %q", value, "claude-haiku-4-5")
	}
}

func TestPickerCard_InitialClamped(t *testing.T) {
	// Initial=99 on a 3-item list should clamp to index 2 (last).
	card := NewPickerCard(samplePayload(99), theme.Dark())
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should resolve on a non-empty payload")
	}
	if value != "claude-haiku-4-5" {
		t.Errorf("clamped initial selection: got %q want %q", value, "claude-haiku-4-5")
	}
}

func TestPickerCard_MoveDown_Clamp(t *testing.T) {
	// At the end of the list, MoveDown should be a no-op.
	card := NewPickerCard(samplePayload(2), theme.Dark())
	card.MoveDown()
	card.MoveDown()
	card.MoveDown()
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should still resolve after MoveDown clamp")
	}
	if value != "claude-haiku-4-5" {
		t.Errorf("MoveDown clamp: got %q want %q", value, "claude-haiku-4-5")
	}
}

func TestPickerCard_MoveUp_Clamp(t *testing.T) {
	// At the start of the list, MoveUp should be a no-op.
	card := NewPickerCard(samplePayload(0), theme.Dark())
	card.MoveUp()
	card.MoveUp()
	card.MoveUp()
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should still resolve after MoveUp clamp")
	}
	if value != "claude-opus-4-7" {
		t.Errorf("MoveUp clamp: got %q want %q", value, "claude-opus-4-7")
	}
}

func TestPickerCard_View_ContainsAllItems(t *testing.T) {
	card := NewPickerCard(samplePayload(0), theme.Dark())
	out := card.View(80)
	for _, label := range []string{"claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"} {
		if !strings.Contains(out, label) {
			t.Errorf("View(80) missing label %q in output:\n%s", label, out)
		}
	}
}

func TestPickerCard_View_HighlightsSelected(t *testing.T) {
	card := NewPickerCard(samplePayload(1), theme.Dark())
	out := card.View(80)
	// The `›` selection prefix should appear exactly once.
	count := strings.Count(out, "›")
	if count != 1 {
		t.Errorf("expected exactly one `›` prefix in View(80) output, got %d:\n%s", count, out)
	}
	// The selected row's label should appear adjacent to the prefix.
	// We can't assert byte ordering of lipgloss escapes reliably, but we
	// can confirm the prefix and the selected label both appear.
	if !strings.Contains(out, "claude-sonnet-4-6") {
		t.Errorf("View(80) missing selected label `claude-sonnet-4-6` in:\n%s", out)
	}
}

func TestPickerCard_View_Footer(t *testing.T) {
	card := NewPickerCard(samplePayload(0), theme.Dark())
	out := card.View(80)
	for _, word := range []string{"navigate", "confirm", "cancel"} {
		if !strings.Contains(out, word) {
			t.Errorf("View(80) footer missing %q in:\n%s", word, out)
		}
	}
}

func TestPickerCard_Selected_EmptyItems(t *testing.T) {
	empty := transport.PickerOpenPayload{
		Title: "Empty picker",
		Items: nil,
	}
	empty.OnSelect.Command = "model"
	card := NewPickerCard(empty, theme.Dark())
	value, ok := card.Selected()
	if ok {
		t.Errorf("Selected() on empty payload should return ok=false; got value=%q", value)
	}
	if value != "" {
		t.Errorf("Selected() value on empty payload should be empty string; got %q", value)
	}
}

func TestPickerCard_Command(t *testing.T) {
	card := NewPickerCard(samplePayload(0), theme.Dark())
	if cmd := card.Command(); cmd != "model" {
		t.Errorf("Command(): got %q want %q", cmd, "model")
	}
}
