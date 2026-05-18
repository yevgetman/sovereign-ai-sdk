// Package components — Prompt: bottom input row.
//
// M2: single-line bubbles/textinput; ENTER does nothing yet (M3 wires submit).
// Width is set by parent on resize.
//
// M11.5 — the prompt now renders inside a rounded lipgloss box (full
// top + side + bottom border with horizontal padding) so the input
// area is a clearly-delimited element instead of a thin horizontal
// rule. Matches the Qwen Code reference layout where the input box
// is the primary focal point of the bottom chrome.

package components

import (
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type Prompt struct {
	ti    textinput.Model
	width int
}

func NewPrompt() Prompt {
	ti := textinput.New()
	ti.Placeholder = "type a message..."
	ti.Prompt = "› "
	ti.Focus()
	return Prompt{ti: ti}
}

func (p Prompt) Update(msg tea.Msg) (Prompt, tea.Cmd) {
	var cmd tea.Cmd
	p.ti, cmd = p.ti.Update(msg)
	return p, cmd
}

func (p *Prompt) SetWidth(w int) {
	p.width = w
	// Reserve 4 columns for the box: 1 left border + 1 left padding +
	// 1 right padding + 1 right border. Textinput then renders inside
	// the box without overflowing.
	p.ti.Width = w - 4
}

func (p Prompt) Value() string {
	return p.ti.Value()
}

func (p *Prompt) Clear() {
	p.ti.SetValue("")
}

// SetValue replaces the prompt input verbatim. Used by the slash-autocomplete
// popup on Tab-complete (M9 T8). Leaves cursor at end.
func (p *Prompt) SetValue(v string) {
	p.ti.SetValue(v)
	p.ti.SetCursor(len(v))
}

func (p Prompt) View() string {
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("#6c7086")). // Catppuccin overlay1 — visible but muted
		Padding(0, 1).
		Width(p.width - 2) // -2 for the left + right border characters
	return box.Render(p.ti.View())
}
