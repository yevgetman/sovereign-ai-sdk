// Package components — ToolCard: bordered card rendering a tool_result event.
//
// Phase 16.1 M3.6: shows tool name + a short summary in a bordered box. The
// renderHint field is preserved so M9 polish branches on it (code, diff,
// markdown, table, tree) and binds to the matching renderer.
//
// M9 T4: when Language is set OR RenderHint == "code", the body renders
// through render.Code; otherwise render.Plain. Expanded toggles between
// the dim Summary line (collapsed) and the full body. Theme drives the
// header color, border color, and body style (ADR M9-01).

package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

type ToolCard struct {
	Tool       string
	RenderHint string
	Summary    string
	Output     string      // M9 T4 — raw tool output rendered when Expanded
	Language   string      // M9 T4 — language hint from ToolResult.Language wire field
	Theme      theme.Theme // M9 T4 — palette for header, border, body
	Expanded   bool        // M9 T6 — collapsed by default; auto-expanded for diffs
}

func (tc ToolCard) View(width int) string {
	if width <= 4 {
		// Fall back to plain text when the terminal is too narrow for a
		// bordered box; lipgloss would still render but the math gets noisy.
		return fmt.Sprintf("[%s] %s", tc.Tool, tc.Summary)
	}
	header := tc.Theme.HeaderStyle().Render(fmt.Sprintf("> %s", tc.Tool))
	var body string
	switch {
	case tc.Expanded && tc.Output != "":
		if tc.Language != "" || tc.RenderHint == "code" {
			body = render.Code(tc.Output, tc.Language, tc.Theme, width-4)
		} else {
			body = render.Plain(tc.Output, tc.Theme, width-4)
		}
	default:
		body = lipgloss.NewStyle().Foreground(tc.Theme.Info).Render(tc.Summary)
	}
	box := tc.Theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(header + "\n" + body)
}
