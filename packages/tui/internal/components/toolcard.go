// Package components — ToolCard: placeholder rendering of a tool_result event.
//
// Phase 16.1 M3.6: shows tool name + a short summary in a bordered box. The
// renderHint field is preserved on the struct so M9 polish can branch on it
// (code/diff/markdown/table/tree) and bind to the matching renderer; M3
// just shows the hint string in the summary line for visual feedback.

package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

type ToolCard struct {
	Tool       string
	RenderHint string
	Summary    string
}

func (tc ToolCard) View(width int) string {
	if width <= 4 {
		// Fall back to plain text when the terminal is too narrow for a
		// bordered box; lipgloss would still render but the math gets
		// noisy.
		return fmt.Sprintf("[%s] %s", tc.Tool, tc.Summary)
	}
	box := lipgloss.NewStyle().
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("#444c56")).
		Padding(0, 1).
		Width(width - 2)
	header := lipgloss.NewStyle().
		Foreground(lipgloss.Color("#98c379")).
		Render(fmt.Sprintf("> %s", tc.Tool))
	subline := lipgloss.NewStyle().
		Foreground(lipgloss.Color("#6e7681")).
		Render(tc.Summary)
	return box.Render(header + "\n" + subline)
}
