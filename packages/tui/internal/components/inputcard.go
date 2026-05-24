// Package components — InputCard: inline scroll-flow card rendered in
// response to an `inputOpen` dispatcher side-effect. 2026-05-24 config
// UX rebuild.
//
// Architecture: parallel to PickerCard but for free-text edits. When a
// catalog item's editor kind is `string` | `number` | `secret`, the
// server emits an `inputOpen` side-effect with title / subtitle /
// initial / placeholder / masked / onSubmit metadata. The TUI receives
// the payload, instantiates an InputCard, and locks input until the
// user confirms (Enter dispatches `<onSubmit.command> <value>`) or
// cancels (Esc).
//
// Visual convention mirrors PickerCard (so a /config edit flow visually
// continues from the submenu picker into the editor): bold title, dim
// italic subtitle, the text input box, and a recessive grey-blue
// italic footer hint. Box is theme.CardBorderStyle() with the same
// padding(0, 1) and width-2 math.
//
// Masked mode (secrets) uses textinput.EchoPassword so the typed value
// renders as bullets — same UX as a typical password field.

package components

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// InputCard is a Bubble Tea component that renders an inline text
// input card. Construct with NewInputCard; pass key events through
// Update; read the typed value via Value(); read the dispatch command
// via Command(). The component is value-mutated (pointer receiver
// methods) to match the shape used by PickerCard.
type InputCard struct {
	payload transport.InputOpenPayload
	input   textinput.Model
	theme   theme.Theme
}

// NewInputCard returns an InputCard ready to render. The textinput is
// pre-populated with payload.Initial (the current persisted value, if
// any) and focused immediately so the user can start typing on the
// next keystroke. When Masked is true, EchoMode is EchoPassword so
// secret values render as bullets.
//
// The Prompt is stripped — the InputCard's outer chrome (title +
// border) is the visual frame; we don't want a redundant "> " marker.
func NewInputCard(payload transport.InputOpenPayload, t theme.Theme) InputCard {
	ti := textinput.New()
	ti.Prompt = ""
	if payload.Placeholder != "" {
		ti.Placeholder = payload.Placeholder
	}
	if payload.Initial != "" {
		ti.SetValue(payload.Initial)
	}
	if payload.Masked {
		ti.EchoMode = textinput.EchoPassword
	} else {
		ti.EchoMode = textinput.EchoNormal
	}
	// CharLimit 0 = no limit; same default the bubble's New() sets.
	// Width is set per-render in View(); the textinput's internal
	// viewport math handles overflow.
	ti.Focus()
	return InputCard{
		payload: payload,
		input:   ti,
		theme:   t,
	}
}

// Update forwards the message to the embedded textinput. Returns the
// updated card + any Cmd produced (typically a cursor blink tick).
// The caller (app.go) is responsible for intercepting Enter/Esc BEFORE
// calling Update — same pattern as PickerCard's MoveUp/MoveDown +
// caller-managed Enter/Esc routing.
func (i *InputCard) Update(msg tea.Msg) (InputCard, tea.Cmd) {
	var cmd tea.Cmd
	i.input, cmd = i.input.Update(msg)
	return *i, cmd
}

// View renders the input card. `width` is the total width of the card
// including its border. When width < 6 the box is dropped and the
// inner body is returned bare — mirrors PickerCard's narrow-terminal
// fallback so the card still degrades gracefully.
func (i InputCard) View(width int) string {
	var lines []string

	// Title — bold, no Foreground so the terminal default fg renders
	// bright. Same approach as PickerCard (M11.14).
	titleStyle := lipgloss.NewStyle().Bold(true)
	lines = append(lines, titleStyle.Render(i.payload.Title))

	// Subtitle — dim italic, only when present.
	if i.payload.Subtitle != "" {
		subtitleStyle := lipgloss.NewStyle().Foreground(i.theme.Dim).Italic(true)
		lines = append(lines, subtitleStyle.Render(i.payload.Subtitle))
	}

	// Empty line of spacing above the input so the editor doesn't sit
	// flush against the subtitle/title.
	lines = append(lines, "")

	// The text input. Width is set per-render to match the card's
	// inner width (account for the box's padding(0,1) = 2 cols + the
	// border's 2 cols = 4 cols of total chrome).
	innerW := width - 4
	if innerW < 10 {
		innerW = width
	}
	i.input.Width = innerW
	lines = append(lines, i.input.View())

	// Empty line of spacing before the footer, mirroring PickerCard's
	// "\n\n" separator between content and footer (M11.16).
	lines = append(lines, "")

	// Footer — recessive grey-blue italic, same shade PickerCard uses
	// for its navigation hint so the two cards read as a matched pair.
	footerStyle := lipgloss.NewStyle().Foreground(pickerFooterColor).Italic(true)
	lines = append(lines, footerStyle.Render("enter submit · esc cancel"))

	body := strings.Join(lines, "\n")

	if width < 6 {
		return body
	}
	box := i.theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(body)
}

// Value returns the current text in the input field. Used by the
// app.go Enter handler to dispatch `<onSubmit.command> <value>`.
func (i InputCard) Value() string {
	return i.input.Value()
}

// Command returns the slash command to re-dispatch on submit, drawn
// from the payload's OnSubmit.Command. The app.go Enter handler
// concatenates the command with the Value() before POSTing.
func (i InputCard) Command() string {
	return i.payload.OnSubmit.Command
}

// Masked reports whether the input is in EchoPassword mode. Test
// helper — production code doesn't need to inspect this. 2026-05-24.
func (i InputCard) Masked() bool {
	return i.input.EchoMode == textinput.EchoPassword
}

// SetTheme swaps the theme used by subsequent View() calls.
func (i *InputCard) SetTheme(t theme.Theme) {
	i.theme = t
}
