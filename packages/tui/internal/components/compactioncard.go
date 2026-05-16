// Package components — CompactionCard: inline pill marking a
// compaction_complete event in the transcript (M9 T7). ADR M9-08: marker is
// an inline transcript element, not a status-line indicator — compaction
// is a discrete in-history moment, not a continuous state.

package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// RenderCompactionCard renders a full-width inline pill with the
// before→after token deltas and the new (child) session id. width < 6
// falls back to a plain bracketed label so very-narrow terminals don't
// crash on box math.
func RenderCompactionCard(beforeTokens, afterTokens int, newSessionShortID string, t theme.Theme, width int) string {
	label := fmt.Sprintf("« compacted %d→%d tokens — new session %s »",
		beforeTokens, afterTokens, newSessionShortID)
	if width <= 6 {
		return fmt.Sprintf("[compacted %d→%d]", beforeTokens, afterTokens)
	}
	style := lipgloss.NewStyle().
		Foreground(t.Warning).
		Bold(true).
		Width(width).
		Align(lipgloss.Center).
		BorderStyle(lipgloss.NormalBorder()).
		BorderTop(true).
		BorderBottom(true).
		BorderForeground(t.Border)
	return style.Render(label)
}
