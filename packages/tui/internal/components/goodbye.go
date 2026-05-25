// Package components — GoodbyeCard: styled session-summary panel rendered
// on /quit (M9 T7). Consumes the rich SessionSummaryEvent payload from M8
// T7 (tokens, cost, durations, tool counts) and degrades gracefully when
// the M8 extension fields are absent (M7-vintage payloads).
//
// ADR M9-09 — render M7-shape minimum (totalDispatched + byAgent) when
// the extension fields are nil; suppress the rich block.

package components

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// RenderGoodbye produces the centered card string. width and height are the
// outer terminal dimensions; the card sizes itself ~60% wide and centered.
// Returns empty for zero dimensions (defensive — render-only tests can hand
// in a zero Model and we shouldn't crash).
func RenderGoodbye(summary transport.SessionSummary, t theme.Theme, width, height int) string {
	if width <= 0 || height <= 0 {
		return ""
	}
	cardWidth := width * style.S.Goodbye.WidthNumerator / style.S.Goodbye.WidthDenominator
	if cardWidth < 40 {
		cardWidth = width - 4
	}
	if cardWidth < 20 {
		cardWidth = 20
	}

	titleStyle := lipgloss.NewStyle().Foreground(t.Primary).Bold(true)
	labelStyle := lipgloss.NewStyle().Foreground(t.Dim)
	valStyle := lipgloss.NewStyle().Foreground(t.Foreground)

	var lines []string
	lines = append(lines, titleStyle.Render("Session summary"))
	lines = append(lines, "")

	// Token + cost block (M8 T7 extension fields).
	if summary.Tokens != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render(padRight("tokens in", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", summary.Tokens.Input))))
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render(padRight("tokens out", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", summary.Tokens.Output))))
		if summary.Tokens.CacheRead != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render(padRight("cache read", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", *summary.Tokens.CacheRead))))
		}
		if summary.Tokens.CacheWrite != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render(padRight("cache wrt", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", *summary.Tokens.CacheWrite))))
		}
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render(padRight("est cost", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("$%.4f", summary.Tokens.EstimatedCostUsd))))
		lines = append(lines, "")
	}

	// Tool block (M8 T7 extension fields).
	if summary.ToolCalls != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render(padRight("tool calls", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", *summary.ToolCalls))))
		if summary.ToolOk != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render(padRight("  ok", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", *summary.ToolOk))))
		}
		if summary.ToolErr != nil {
			lines = append(lines, fmt.Sprintf("%s  %s",
				labelStyle.Render(padRight("  err", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", *summary.ToolErr))))
		}
		lines = append(lines, "")
	}

	// Duration block (M8 T7 extension fields).
	durationsShown := false
	if summary.AgentActiveMs != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render(padRight("active ms", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%.0f", *summary.AgentActiveMs))))
		durationsShown = true
	}
	if summary.APITimeMs != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render(padRight("api ms", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%.0f", *summary.APITimeMs))))
		durationsShown = true
	}
	if summary.ToolTimeMs != nil {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render(padRight("tool ms", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%.0f", *summary.ToolTimeMs))))
		durationsShown = true
	}
	if durationsShown {
		lines = append(lines, "")
	}

	// M7 base shape (always shown).
	lines = append(lines, fmt.Sprintf("%s  %s",
		labelStyle.Render(padRight("forks", style.S.Goodbye.LabelPad)), valStyle.Render(fmt.Sprintf("%d", summary.TotalDispatched))))
	// Sort agent names for deterministic rendering.
	agentNames := make([]string, 0, len(summary.ByAgent))
	for k := range summary.ByAgent {
		agentNames = append(agentNames, k)
	}
	sort.Strings(agentNames)
	for _, agent := range agentNames {
		lines = append(lines, fmt.Sprintf("%s  %s",
			labelStyle.Render("  "+padRight(agent, style.S.Goodbye.AgentPad)), valStyle.Render(fmt.Sprintf("%d", summary.ByAgent[agent]))))
	}

	body := strings.Join(lines, "\n")
	box := t.CardBorderStyle().Padding(style.S.Card.GenerousPaddingV, style.S.Card.GenerousPaddingH).Width(cardWidth).Render(body)
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// padRight returns s padded with spaces to at least n runes wide. If s is
// already that wide or wider, returns s unchanged.
func padRight(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}
