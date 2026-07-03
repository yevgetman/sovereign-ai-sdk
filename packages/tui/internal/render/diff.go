package render

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// Hunk is a parsed diff hunk — header + body lines, each tagged with diff
// status. v1 ignores file rename / mode metadata; only unified-diff bodies.
type Hunk struct {
	Header string // e.g., "@@ -1,4 +1,5 @@"
	Lines  []HunkLine
}

// HunkLine carries a single diff line stripped of its leading +/-/space
// marker, plus the kind for theme-driven styling.
type HunkLine struct {
	Kind DiffLineKind
	Text string
}

// DiffLineKind identifies the role of a single diff line.
type DiffLineKind int

const (
	// DiffContext is an unchanged line (leading space in unified diff).
	DiffContext DiffLineKind = iota
	// DiffAdded is an added line (leading +).
	DiffAdded
	// DiffRemoved is a removed line (leading -).
	DiffRemoved
)

// ParseDiff splits a unified diff into hunks. Returns an empty slice for
// input that contains no hunk headers. The parser is intentionally lenient
// — malformed bodies pass through as DiffContext lines so the caller can
// always render something.
func ParseDiff(text string) []Hunk {
	var hunks []Hunk
	var current *Hunk
	for _, raw := range strings.Split(text, "\n") {
		if strings.HasPrefix(raw, "@@") {
			if current != nil {
				hunks = append(hunks, *current)
			}
			current = &Hunk{Header: raw}
			continue
		}
		if current == nil {
			continue
		}
		switch {
		case strings.HasPrefix(raw, "+"):
			current.Lines = append(current.Lines, HunkLine{Kind: DiffAdded, Text: raw[1:]})
		case strings.HasPrefix(raw, "-"):
			current.Lines = append(current.Lines, HunkLine{Kind: DiffRemoved, Text: raw[1:]})
		default:
			// Skip zero-length lines (trailing newline from split). A
			// single-space line " " is a legitimate empty context line —
			// we keep that one because HasPrefix(" ") still strips the
			// marker correctly.
			if raw == "" {
				continue
			}
			text := raw
			if strings.HasPrefix(raw, " ") {
				text = raw[1:]
			}
			current.Lines = append(current.Lines, HunkLine{Kind: DiffContext, Text: text})
		}
	}
	if current != nil {
		hunks = append(hunks, *current)
	}
	return hunks
}

// RenderHunks renders all hunks with the hunk at activeIdx highlighted via
// a left-side ▶ marker on its header. activeIdx out of bounds (negative or
// >= len) means no highlight. width is the wrap column; left to the caller
// to enforce (this function trusts the caller's box layout).
func RenderHunks(hunks []Hunk, activeIdx int, t theme.Theme, width int) string {
	if len(hunks) == 0 {
		return ""
	}
	addStyle := lipgloss.NewStyle().Foreground(t.DiffAdded)
	remStyle := lipgloss.NewStyle().Foreground(t.DiffRemoved)
	ctxStyle := lipgloss.NewStyle().Foreground(t.DiffContext)
	headerStyle := lipgloss.NewStyle().Foreground(t.Primary).Bold(true)
	activeHeaderStyle := lipgloss.NewStyle().Foreground(t.Warning).Bold(true)
	var sb strings.Builder
	for i, h := range hunks {
		if i == activeIdx {
			sb.WriteString(activeHeaderStyle.Render(style.S.Diff.HunkMarker + h.Header))
		} else {
			sb.WriteString(headerStyle.Render(h.Header))
		}
		sb.WriteString("\n")
		for _, line := range h.Lines {
			switch line.Kind {
			case DiffAdded:
				sb.WriteString(addStyle.Render(style.S.Diff.AddedPrefix + line.Text))
			case DiffRemoved:
				sb.WriteString(remStyle.Render(style.S.Diff.RemovedPrefix + line.Text))
			default:
				sb.WriteString(ctxStyle.Render(style.S.Diff.ContextPrefix + line.Text))
			}
			sb.WriteString("\n")
		}
		if i < len(hunks)-1 {
			sb.WriteString("\n")
		}
	}
	// width is reserved for future per-line wrapping; v1 trusts callers.
	_ = width
	return strings.TrimRight(sb.String(), "\n")
}
