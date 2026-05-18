// Package components — StatusLine: bottom anchored status row.
//
// M2: hardcoded fields (cwd, provider, model placeholders). M3 wires real
// state. M9 T10: themed; consumes status_update SSE events to drive a
// streaming spinner and a live cost field on the right side.

package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
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
	TokensIn  int
	TokensOut int
	Theme     theme.Theme

	// M9 T10 — spinner frame index, advanced by Tick events from app.go.
	spinner int
}

// spinnerFrames is the braille-spinner animation used during streaming.
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// NewStatusLine returns a status line with default placeholder values.
// Theme is constructor-injected per ADR M9-01.
func NewStatusLine(t theme.Theme) StatusLine {
	return StatusLine{
		Cwd:      "?",
		Profile:  "default",
		Provider: "?",
		Model:    "?",
		Theme:    t,
	}
}

func (s *StatusLine) SetWidth(w int) {
	s.width = w
}

// SetTheme swaps the active theme. Called from app.go's /theme handler.
func (s *StatusLine) SetTheme(t theme.Theme) {
	s.Theme = t
}

// AdvanceSpinner moves to the next frame. Called from app.go's spinner Tick.
func (s *StatusLine) AdvanceSpinner() {
	s.spinner = (s.spinner + 1) % len(spinnerFrames)
}

// SpinnerFrame returns the current frame character. Exposed for testing.
func (s StatusLine) SpinnerFrame() string {
	return spinnerFrames[s.spinner]
}

func (s StatusLine) View() string {
	// M11.5 — drop the explicit background fill. On terminals where
	// the configured theme.Background hex doesn't match the actual
	// terminal background the filled row reads as a distracting
	// light strip. Letting the terminal background show through keeps
	// the status line subtle and consistent regardless of how the
	// terminal maps the theme's base color. The left half uses dim
	// foreground (not the theme's full Foreground) so the path /
	// profile / model read as ambient metadata, not primary content.
	dimFg := lipgloss.NewStyle().Foreground(s.Theme.Dim)

	left := dimFg.Render(fmt.Sprintf("%s  %s  %s",
		s.Cwd,
		s.Profile,
		s.Model,
	))

	right := dimFg.Render(fmt.Sprintf("$%.4f  cache %.0f%%", s.Cost, s.CacheHit*100))
	if s.Streaming {
		spinStyle := lipgloss.NewStyle().Foreground(s.Theme.Primary).Bold(true)
		spin := spinStyle.Render(spinnerFrames[s.spinner])
		right = spin + "  " + right
	}

	// Lay out left + right with padding between to fill width. The
	// padding row uses no styling so the terminal background fills
	// the gap naturally.
	padding := s.width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if padding < 1 {
		padding = 1
	}
	gap := lipgloss.NewStyle().Width(padding).Render(" ")
	return " " + left + gap + right + " "
}
