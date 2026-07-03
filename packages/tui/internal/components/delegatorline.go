// Package components — DelegatorLine: compact, single-line rendering of
// the four delegator_* SSE events synthesized by the Phase 2 T4 router.
//
// Aesthetic match for the existing compact tool-line family
// (compactline.go) — verb-first, dim trailing details, status glyphs
// (✓ / ✗) on completion lines. The user reads a delegated turn as a
// "Delegating" header, a sequence of "→ atom N on <lane>" + "✓/✗ atom N"
// pairs, and a "Done. <n> atoms: ..." summary footer.
//
// Layout examples (theme.Dark()):
//
//	◇ Delegating …                                       ← plan
//	→ atom 0 on cheap-task: Summarize this file          ← started
//	✓ atom 0 on cheap-task (1234ms)                      ← complete (success)
//	✗ atom 1 on reasoning failed (42ms)                  ← complete (failure)
//	◆ Done. 3 atoms: cheap-task=2, reasoning=1           ← summary
//
// Lane distribution in the summary is sorted by count desc, then by name
// asc, so identical turns produce identical strings (testable).

package components

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

// FormatDelegatorPlanLine renders the "delegating started" marker. When
// the event carries a scheduledAtomCount (future synthesis variants),
// it's surfaced inline; today the marker prints an ellipsis indicating
// the plan is unfolding atom-by-atom.
func FormatDelegatorPlanLine(ev transport.DelegatorPlanEvent, t theme.Theme, width int) string {
	prefix := lipgloss.NewStyle().
		Foreground(lipgloss.Color(style.S.Brand.AccentColor)).
		Bold(true).
		Render(style.S.Glyph.Plan + " Delegating")
	var tail string
	if ev.ScheduledAtomCount != nil {
		tail = lipgloss.NewStyle().
			Foreground(t.Info).
			Render(fmt.Sprintf(" %d atom(s) planned", *ev.ScheduledAtomCount))
	} else {
		tail = lipgloss.NewStyle().Foreground(t.Info).Render(" …")
	}
	return style.S.Delegator.Indent + prefix + tail
}

// FormatDelegatorAtomStartedLine renders an in-flight atom dispatch:
//
//	→ atom <idx> on <lane>: <preview>
//
// When `debugMode` is true AND the event carries LaneProvider/LaneModel
// (Phase 2.5 patch), the lane segment is suffixed with the resolved
// provider/model in brackets:
//
//	→ atom <idx> on <lane> [provider/model]: <preview>
//
// Surfaces granular routing detail without changing the default look.
func FormatDelegatorAtomStartedLine(
	ev transport.DelegatorAtomStartedEvent,
	t theme.Theme,
	width int,
	debugMode bool,
) string {
	glyph := lipgloss.NewStyle().Foreground(lipgloss.Color(style.S.Brand.AccentColor)).Render(style.S.Glyph.Arrow)
	verb := lipgloss.NewStyle().
		Foreground(t.Foreground).
		Render(fmt.Sprintf(" atom %d on ", ev.AtomIndex))
	lane := lipgloss.NewStyle().
		Foreground(lipgloss.Color(style.S.Brand.AccentColor)).
		Bold(true).
		Render(ev.LaneName)
	debug := formatLaneDebugSuffix(debugMode, ev.LaneProvider, ev.LaneModel, t)

	// Build the fixed prefix to measure how much room the preview gets.
	fixedPlain := style.S.Delegator.Indent + style.S.Glyph.Arrow +
		fmt.Sprintf(" atom %d on ", ev.AtomIndex) + ev.LaneName
	if debugMode && (ev.LaneProvider != "" || ev.LaneModel != "") {
		body := ev.LaneProvider
		if ev.LaneProvider != "" && ev.LaneModel != "" {
			body = ev.LaneProvider + "/" + ev.LaneModel
		} else if ev.LaneModel != "" {
			body = ev.LaneModel
		}
		fixedPlain += " [" + body + "]"
	}
	preview := ""
	if ev.PromptPreview != "" {
		previewText := ": " + ev.PromptPreview
		avail := width - len([]rune(fixedPlain)) - 2 // 2 for ": " minimum
		if avail > 6 && len([]rune(previewText)) > avail {
			runes := []rune(previewText)
			previewText = string(runes[:avail-1]) + "…"
		}
		preview = lipgloss.NewStyle().
			Foreground(t.Info).
			Render(previewText)
	}
	return style.S.Delegator.Indent + glyph + verb + lane + debug + preview
}

// formatLaneDebugSuffix renders the bracketed `[provider/model]` tail
// shown after the lane name when debug mode is on. Returns "" when
// debug mode is off OR the event lacked provider/model info (e.g., a
// replayed JSONL transcript from before the laneProvider/laneModel
// fields were added).
func formatLaneDebugSuffix(debugMode bool, provider, model string, t theme.Theme) string {
	if !debugMode {
		return ""
	}
	if provider == "" && model == "" {
		return ""
	}
	body := provider
	if provider != "" && model != "" {
		body = provider + "/" + model
	} else if model != "" {
		body = model
	}
	return lipgloss.NewStyle().Foreground(t.Dim).Render(" [" + body + "]")
}

// FormatDelegatorAtomCompleteLine renders the terminal line for an atom —
// success or failure. The lane name pops in t.Primary so a quick scan of
// the column reads as "where did the work go?". Duration is dim trailing.
//
// When `debugMode` is true AND the event carries LaneProvider/LaneModel,
// the lane segment is suffixed with `[provider/model]` for symmetry
// with the started-line rendering.
func FormatDelegatorAtomCompleteLine(
	ev transport.DelegatorAtomCompleteEvent,
	t theme.Theme,
	width int,
	debugMode bool,
) string {
	var (
		glyphChar  string
		glyphColor lipgloss.Color
		tail       string
	)
	if ev.Success {
		glyphChar = style.S.Glyph.Success
		glyphColor = t.Success
	} else {
		glyphChar = style.S.Glyph.Error
		glyphColor = t.Error
	}
	glyph := lipgloss.NewStyle().Foreground(glyphColor).Bold(true).Render(glyphChar)
	verb := lipgloss.NewStyle().
		Foreground(t.Foreground).
		Render(fmt.Sprintf(" atom %d on ", ev.AtomIndex))
	lane := lipgloss.NewStyle().
		Foreground(lipgloss.Color(style.S.Brand.AccentColor)).
		Bold(true).
		Render(ev.LaneName)
	debug := formatLaneDebugSuffix(debugMode, ev.LaneProvider, ev.LaneModel, t)
	if ev.Success {
		tail = lipgloss.NewStyle().
			Foreground(t.Info).
			Render(fmt.Sprintf(" (%dms)", ev.DurationMs))
	} else {
		tail = lipgloss.NewStyle().
			Foreground(t.Info).
			Render(fmt.Sprintf(" failed (%dms)", ev.DurationMs))
	}
	return style.S.Delegator.Indent + glyph + verb + lane + debug + tail
}

// FormatDelegatorCompleteLine renders the closing summary:
//
//	◆ Done. <total> atoms: <lane>=<count>, <lane>=<count>, …
//
// The lane distribution is sorted by count desc, then by name asc, so
// the rendered text is deterministic for testing and for the user's
// scanning eye.
func FormatDelegatorCompleteLine(ev transport.DelegatorCompleteEvent, t theme.Theme, width int) string {
	prefix := lipgloss.NewStyle().
		Foreground(t.Success).
		Bold(true).
		Render(style.S.Glyph.Done + " Done.")
	count := lipgloss.NewStyle().
		Foreground(lipgloss.Color(style.S.Brand.AccentColor)).
		Render(fmt.Sprintf(" %d atom(s)", ev.TotalAtomCount))
	distribution := formatLaneDistribution(ev.LaneDistribution, t)
	return style.S.Delegator.Indent + prefix + count + distribution
}

// formatLaneDistribution renders the lane breakdown for the summary
// line. Returns "" when the map is empty.
//
// Sort order: count descending (most-used lane first), then by name
// ascending for stable output across identical turns.
func formatLaneDistribution(dist map[string]int, t theme.Theme) string {
	if len(dist) == 0 {
		return ""
	}
	type laneEntry struct {
		name  string
		count int
	}
	entries := make([]laneEntry, 0, len(dist))
	for name, count := range dist {
		entries = append(entries, laneEntry{name: name, count: count})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].count != entries[j].count {
			return entries[i].count > entries[j].count
		}
		return entries[i].name < entries[j].name
	})
	parts := make([]string, 0, len(entries))
	for _, e := range entries {
		parts = append(parts, fmt.Sprintf("%s=%d", e.name, e.count))
	}
	return lipgloss.NewStyle().
		Foreground(t.Info).
		Render(": " + strings.Join(parts, ", "))
}
