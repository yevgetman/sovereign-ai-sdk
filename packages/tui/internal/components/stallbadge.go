// Package components — StallBadge: 1-line warning surface for stall_detected
// events (M8 T7 wire schema). ADR M9.6-02: badge auto-fades 5s after the
// event; new events reset the timer via a generation counter tracked by
// app.go.

package components

import (
	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// StallBadge is a value-typed warning surface. app.go stashes a pointer
// when a stall_detected event arrives + dispatches a tea.Tick(5s, …) for
// auto-clear.
type StallBadge struct {
	Reason string
	Theme  theme.Theme
}

// View renders a single line with theme.Warning foreground + bold. Width
// is the terminal width; zero or negative returns empty.
func (b StallBadge) View(width int) string {
	if width <= 0 {
		return ""
	}
	style := lipgloss.NewStyle().
		Foreground(b.Theme.Warning).
		Bold(true).
		Width(width).
		Padding(0, 1)
	text := "⚠ stalled"
	if b.Reason != "" {
		text = "⚠ stalled — " + b.Reason
	}
	return style.Render(text)
}
