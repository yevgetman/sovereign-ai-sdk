// Package components — StatusLine: bottom anchored status row.
//
// M2: hardcoded fields (cwd, provider, model placeholders). M3 wires real
// state from status_update events.

package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

type StatusLine struct {
	width     int
	Cwd       string
	Profile   string
	Provider  string
	Model     string
	Cost      float64
	CacheHit  float64
	Streaming bool
}

func NewStatusLine() StatusLine {
	return StatusLine{
		Cwd:      "?",
		Profile:  "default",
		Provider: "?",
		Model:    "?",
	}
}

func (s *StatusLine) SetWidth(w int) {
	s.width = w
}

func (s StatusLine) View() string {
	bg := lipgloss.NewStyle().
		Width(s.width).
		Padding(0, 1).
		Foreground(lipgloss.Color("#8b949e")).
		Background(lipgloss.Color("#161b22"))

	stream := ""
	if s.Streaming {
		stream = "  streaming●"
	}
	text := fmt.Sprintf("%s  %s  %s  $%.2f  cache %.0f%%%s",
		s.Cwd,
		s.Profile,
		s.Model,
		s.Cost,
		s.CacheHit*100,
		stream,
	)
	return bg.Render(text)
}
