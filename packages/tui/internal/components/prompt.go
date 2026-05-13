// Package components — Prompt: bottom input row.
//
// M2: single-line bubbles/textinput; ENTER does nothing yet (M3 wires submit).
// Width is set by parent on resize.

package components

import (
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type Prompt struct {
	ti       textinput.Model
	width    int
	disabled bool
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
	p.ti.Width = w - 4
}

func (p Prompt) Value() string {
	return p.ti.Value()
}

func (p *Prompt) Clear() {
	p.ti.SetValue("")
}

func (p Prompt) View() string {
	border := lipgloss.NewStyle().BorderTop(true).BorderStyle(lipgloss.NormalBorder()).BorderForeground(lipgloss.Color("#444c56"))
	return border.Width(p.width).Render(p.ti.View())
}
