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
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// ToolCardHeaderColor is the fixed brand-purple hex used for the
// "> <Tool>" header line on every tool card. Pinned outside the theme
// tokens because the header must read as on-brand purple/pink across
// every theme (same rationale as the splash + spinner gradient, which
// are also theme-independent). #a78bfa is the "soft purple" anchor
// from the SOV gradient (blue → teal → purple → pink). Per
// docs/conventions/tui-color-rendering.md, accents that must read as a
// specific shade family rather than just "some accent color" get
// pinned to a fixed hex rather than derived from theme.Primary.
const ToolCardHeaderColor = "#a78bfa"

type ToolCard struct {
	Tool       string
	RenderHint string
	Summary    string
	Input      string      // M9 T6 — tool input preview (truncated when collapsed)
	Output     string      // M9 T4 — raw tool output rendered when Expanded
	Language   string      // M9 T4 — language hint from ToolResult.Language wire field
	Theme      theme.Theme // M9 T4 — palette for header, border, body
	Expanded   bool        // M9 T6 — collapsed by default; auto-expanded for diffs
	Diff       *DiffView   // M9 T5 — when set + Expanded, body renders the diff
	// InlineLines caps the rendered Output to this many rows; the surplus
	// is summarized with a dim "…[+N more lines]" footer. 0 = uncapped
	// (legacy behavior). Diff path is unaffected — DiffView produces its
	// own compact rendering and is left intact. ux-fixes 2026-05-22.
	InlineLines int
}

func (tc ToolCard) View(width int) string {
	if width <= 4 {
		// Fall back to plain text when the terminal is too narrow for a
		// bordered box; lipgloss would still render but the math gets noisy.
		return fmt.Sprintf("[%s] %s", tc.Tool, tc.Summary)
	}
	// M9 T6 — header carries tool name + (when collapsed + Input set) a
	// truncated input preview. Expanded card body shows the full input + output;
	// collapsed body shows only the dim summary.
	//
	// ux-fixes — tool-card header uses a fixed brand-purple hex
	// (ToolCardHeaderColor, the SOV-gradient "soft purple" anchor)
	// rather than theme.Primary. See the const declaration above for
	// the full rationale.
	header := lipgloss.NewStyle().
		Foreground(lipgloss.Color(ToolCardHeaderColor)).
		Bold(true).
		Render(fmt.Sprintf("> %s", tc.Tool))
	if !tc.Expanded && tc.Input != "" {
		preview := truncatePreview(tc.Input, width-len(tc.Tool)-6)
		previewStyle := lipgloss.NewStyle().Foreground(tc.Theme.Dim)
		header = header + "  " + previewStyle.Render(preview)
	}
	var body string
	switch {
	case tc.Diff != nil && tc.Expanded:
		// M9 T5 — diff view rendering. Pointer indirection because app.go
		// retains a reference to the same DiffView to route j/k focus events.
		body = tc.Diff.View(width - 4)
	case tc.Expanded && tc.Output != "":
		// ux-fixes 2026-05-22 — detailed-mode truncation. When
		// InlineLines > 0, cap the rendered Output to N rows + dim
		// "…[+M more lines]" footer. The truncation runs BEFORE the
		// chroma/plain rendering so the syntax highlighter doesn't
		// waste work on dropped lines.
		out := tc.Output
		var truncFooter string
		if tc.InlineLines > 0 {
			lines := strings.Split(out, "\n")
			if len(lines) > tc.InlineLines {
				remaining := len(lines) - tc.InlineLines
				out = strings.Join(lines[:tc.InlineLines], "\n")
				truncFooter = lipgloss.NewStyle().
					Foreground(tc.Theme.Dim).
					Italic(true).
					Render(fmt.Sprintf("…[+%d more lines]", remaining))
			}
		}
		if tc.Language != "" || tc.RenderHint == "code" {
			body = render.Code(out, tc.Language, tc.Theme, width-4)
		} else {
			body = render.Plain(out, tc.Theme, width-4)
		}
		if truncFooter != "" {
			body = body + "\n" + truncFooter
		}
	default:
		body = lipgloss.NewStyle().Foreground(tc.Theme.Info).Render(tc.Summary)
	}
	box := tc.Theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(header + "\n" + body)
}

// truncatePreview returns a single-line preview of input, clamped to max
// runes with an ellipsis when truncated. Newlines flatten to spaces so the
// preview never breaks the card layout. max <= 0 returns empty.
func truncatePreview(input string, max int) string {
	if max <= 0 {
		return ""
	}
	flat := strings.ReplaceAll(input, "\n", " ")
	flat = strings.TrimSpace(flat)
	if len(flat) <= max {
		return flat
	}
	if max <= 3 {
		return flat[:max]
	}
	return flat[:max-3] + "..."
}
