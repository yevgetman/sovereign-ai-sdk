// Package render — pure renderers for the Phase 16.1 TUI. Functions take
// (text, theme, width) and return a styled string. No state, no tea.Msg,
// no I/O (ADR M9-02).
package render

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// Plain renders text wrapped at width, foreground set to theme.Foreground.
// This is the fallback when markdown / chroma parsing fails or when the
// caller has no language hint.
func Plain(text string, t theme.Theme, width int) string {
	if width <= 0 {
		return text
	}
	style := lipgloss.NewStyle().
		Foreground(t.Foreground).
		Width(width)
	return style.Render(strings.TrimRight(text, "\n"))
}
