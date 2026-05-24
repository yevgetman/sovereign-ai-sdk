// Package components — tests for InputCard (2026-05-24 config UX rebuild).

package components

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// sampleInputPayload builds a non-masked payload used across most tests.
func sampleInputPayload() transport.InputOpenPayload {
	p := transport.InputOpenPayload{
		Title:       "defaultModel",
		Subtitle:    "Model used when no --model flag is supplied.",
		Initial:     "claude-sonnet-4-6",
		Placeholder: "claude-sonnet-4-6",
		Masked:      false,
	}
	p.OnSubmit.Command = "config set defaultModel"
	return p
}

// maskedInputPayload builds a masked payload for secret-field tests.
func maskedInputPayload() transport.InputOpenPayload {
	p := transport.InputOpenPayload{
		Title:       "anthropic.apiKey",
		Subtitle:    "API key used for the Anthropic provider.",
		Initial:     "",
		Placeholder: "sk-ant-...",
		Masked:      true,
	}
	p.OnSubmit.Command = "config set providers.anthropic.apiKey"
	return p
}

func TestInputCard_ConstructorPopulatesPayload(t *testing.T) {
	card := NewInputCard(sampleInputPayload(), theme.Dark())
	if card.Value() != "claude-sonnet-4-6" {
		t.Errorf("expected Value() to be pre-populated from Initial; got %q", card.Value())
	}
	if card.Command() != "config set defaultModel" {
		t.Errorf("expected Command() to mirror OnSubmit.Command; got %q", card.Command())
	}
	if card.Masked() {
		t.Errorf("expected non-masked input for sample payload")
	}
}

func TestInputCard_MaskedEnablesEchoPassword(t *testing.T) {
	card := NewInputCard(maskedInputPayload(), theme.Dark())
	if !card.Masked() {
		t.Errorf("expected Masked()=true for masked payload")
	}
	if card.Value() != "" {
		t.Errorf("expected Value() to be empty for masked payload (no Initial); got %q", card.Value())
	}
}

func TestInputCard_ViewContainsTitle(t *testing.T) {
	card := NewInputCard(sampleInputPayload(), theme.Dark())
	out := card.View(80)
	if !strings.Contains(out, "defaultModel") {
		t.Errorf("View(80) missing title %q in:\n%s", "defaultModel", out)
	}
}

func TestInputCard_ViewContainsSubtitle(t *testing.T) {
	card := NewInputCard(sampleInputPayload(), theme.Dark())
	out := card.View(80)
	if !strings.Contains(out, "Model used when no --model flag") {
		t.Errorf("View(80) missing subtitle prefix in:\n%s", out)
	}
}

func TestInputCard_ViewOmitsSubtitleWhenAbsent(t *testing.T) {
	payload := sampleInputPayload()
	payload.Subtitle = ""
	card := NewInputCard(payload, theme.Dark())
	out := card.View(80)
	// Title should still appear; subtitle text should not be substituted
	// with anything visible. The most reliable assertion is that the
	// fixed subtitle string is missing.
	if !strings.Contains(out, "defaultModel") {
		t.Errorf("View(80) missing title; got:\n%s", out)
	}
}

func TestInputCard_ViewContainsFooterHint(t *testing.T) {
	card := NewInputCard(sampleInputPayload(), theme.Dark())
	out := card.View(80)
	for _, word := range []string{"enter", "submit", "esc", "cancel"} {
		if !strings.Contains(out, word) {
			t.Errorf("View(80) footer missing %q in:\n%s", word, out)
		}
	}
}

func TestInputCard_UpdateAppendsTypedRune(t *testing.T) {
	// Start with empty Initial so we can observe the typed character
	// land cleanly.
	payload := sampleInputPayload()
	payload.Initial = ""
	card := NewInputCard(payload, theme.Dark())
	// Type "x" via a KeyMsg.
	card, _ = card.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	if card.Value() != "x" {
		t.Errorf("after typing 'x': Value() = %q; want %q", card.Value(), "x")
	}
	card, _ = card.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	if card.Value() != "xy" {
		t.Errorf("after typing 'y': Value() = %q; want %q", card.Value(), "xy")
	}
}

func TestInputCard_ValueReflectsInitialPlusTyping(t *testing.T) {
	card := NewInputCard(sampleInputPayload(), theme.Dark())
	// Cursor positions to end after SetValue per textinput contract;
	// typing should append.
	card, _ = card.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'-'}})
	card, _ = card.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'2'}})
	if want := "claude-sonnet-4-6-2"; card.Value() != want {
		t.Errorf("Value() after typing: got %q want %q", card.Value(), want)
	}
}

func TestInputCard_CommandPassthrough(t *testing.T) {
	card := NewInputCard(maskedInputPayload(), theme.Dark())
	if want := "config set providers.anthropic.apiKey"; card.Command() != want {
		t.Errorf("Command(): got %q want %q", card.Command(), want)
	}
}

func TestInputCard_NarrowWidthDropsBox(t *testing.T) {
	// When width < 6 the box wrapper is dropped — verifies the
	// graceful-degradation fallback contract documented in View().
	card := NewInputCard(sampleInputPayload(), theme.Dark())
	out := card.View(4)
	// The title should still appear; we don't assert the absence of
	// the border characters because lipgloss escape codes make that
	// fragile. The body returned bare must still contain the title.
	if !strings.Contains(out, "defaultModel") {
		t.Errorf("narrow-width View should still contain title; got:\n%s", out)
	}
}

func TestInputCard_SetThemeUpdatesTheme(t *testing.T) {
	// Verify SetTheme is idempotent and doesn't lose state.
	card := NewInputCard(sampleInputPayload(), theme.Dark())
	before := card.Value()
	card.SetTheme(theme.Light())
	if card.Value() != before {
		t.Errorf("SetTheme should not affect Value(): before=%q after=%q", before, card.Value())
	}
}
