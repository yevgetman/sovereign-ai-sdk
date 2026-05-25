// Package components — Splash: TUI startup banner.
//
// Mirrors the REPL splash (src/ui/splash.ts) — the "ANSI Shadow" SOV
// block-letter logo with a cyan→blue vertical gradient. Rendered into
// the transcript on Init so users see the same brand cue regardless of
// which surface they're on. M11.1.

package components

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// logoLines is the "ANSI Shadow" figlet font for "SOV". Every row is the
// same width; renderers can pad on the right when they want a fixed block.
var logoLines = []string{
	"  ███████╗ ██████╗ ██╗   ██╗ ",
	"  ██╔════╝██╔═══██╗██║   ██║ ",
	"  ███████╗██║   ██║██║   ██║ ",
	"  ╚════██║██║   ██║╚██╗ ██╔╝ ",
	"  ███████║╚██████╔╝ ╚████╔╝  ",
	"  ╚══════╝ ╚═════╝   ╚═══╝   ",
}


// SplashInfo carries the optional info-card fields rendered next to the
// logo when the terminal is wide enough. Empty fields are skipped.
type SplashInfo struct {
	Version  string
	Provider string // e.g., "anthropic"
	Auth     string // e.g., "API Key"
	Model    string // e.g., "claude-haiku-4-5-20251001"
	Cwd      string // working directory (or bundle path) — abbreviated when long
	Tips     string // tips line under the logo (e.g., "type / for slash commands…")
}

// RenderSplash returns a multi-line splash string for the given width.
// On narrow terminals the logo stacks above the info card; on wide
// terminals they sit side-by-side. The width should be the renderable
// content width (terminal columns minus any frame padding).
func RenderSplash(info SplashInfo, t theme.Theme, width int) string {
	if width <= 0 {
		width = 80
	}
	logoWidth := visualWidthMax(logoLines)
	gutter := style.S.Splash.Gutter
	safetyMargin := style.S.Splash.SafetyMargin

	// Build the info card once and measure it. M11.3 — wrap in a
	// rounded lipgloss border so the card reads as a discrete element
	// (mirrors the REPL splash + the Qwen Code reference layout).
	cardContent := buildInfoCard(info, t)
	var card []string
	if len(cardContent) > 0 {
		// ux-fixes round 3: Padding(1, 2) — 1 row top + bottom and 2
		// cols left + right — gives the info card room to breathe.
		// The pre-existing Padding(0, 1) was visually cramped against
		// the rounded border (ux1.png feedback).
		borderStyle := lipgloss.NewStyle().
			Border(style.S.Card.Border).
			BorderForeground(t.Border).
			Padding(style.S.Card.GenerousPaddingV, style.S.Card.GenerousPaddingH)
		boxed := borderStyle.Render(strings.Join(cardContent, "\n"))
		card = strings.Split(boxed, "\n")
	}
	cardWidth := visualWidthMax(card)

	useStacked := width < logoWidth+gutter+cardWidth+safetyMargin

	var rows []string
	if useStacked {
		// Stack: logo on top, card below. Drop the logo entirely when even
		// the logo can't fit (avoids fragmenting box-drawing glyphs on
		// pathologically narrow terminals).
		if logoWidth+safetyMargin <= width {
			rows = append(rows, colorize(logoLines)...)
			rows = append(rows, "")
		}
		rows = append(rows, card...)
	} else {
		// Side-by-side: pad the shorter block to the taller block's height
		// so the join sees equal-length slices. Center the card vertically
		// against the logo for a balanced look.
		colored := colorize(logoLines)
		height := max(len(colored), len(card))
		left := padBlock(colored, height, logoWidth)
		cardOffset := max(0, (height-len(card))/2)
		right := make([]string, height)
		pad := strings.Repeat(" ", cardWidth)
		for i := 0; i < height; i++ {
			cardIdx := i - cardOffset
			if cardIdx >= 0 && cardIdx < len(card) {
				line := card[cardIdx]
				fill := cardWidth - lipgloss.Width(line)
				if fill < 0 {
					fill = 0
				}
				right[i] = line + strings.Repeat(" ", fill)
			} else {
				right[i] = pad
			}
		}
		for i := 0; i < height; i++ {
			rows = append(rows, left[i]+strings.Repeat(" ", gutter)+right[i])
		}
	}

	if info.Tips != "" {
		rows = append(rows, "")
		tipsStyle := lipgloss.NewStyle().Foreground(t.Dim).Italic(true)
		rows = append(rows, tipsStyle.Render(info.Tips))
	}

	return strings.Join(rows, "\n")
}

// buildInfoCard returns the info-card lines (without an outer border —
// the splash uses a label/value layout for compactness). Empty fields
// are skipped so a fresh-session boot before status_update arrives
// renders a logo + tips line cleanly.
func buildInfoCard(info SplashInfo, t theme.Theme) []string {
	accent := lipgloss.NewStyle().Foreground(t.Primary).Bold(true)
	muted := lipgloss.NewStyle().Foreground(t.Dim)
	// ux-fixes round 3: body text inherits terminal default foreground
	// per the M11.10 rule (docs/conventions/tui-color-rendering.md). A
	// hard `Foreground(t.Foreground)` rendered dark grey on terminals
	// whose palette mapped the theme foreground to a low-contrast slot
	// (ux1.png feedback). Bold-only is the "brightest reliable" path.
	body := lipgloss.NewStyle().Bold(true)
	plain := lipgloss.NewStyle()

	title := accent.Render(">_") + " " + body.Render("Sovereign AI")
	if info.Version != "" {
		title += " " + muted.Render("("+info.Version+")")
	}
	rows := []string{title}

	if info.Provider != "" || info.Auth != "" {
		line := info.Provider
		if info.Provider != "" && info.Auth != "" {
			line += " " + muted.Render("|") + " " + info.Auth
		} else if info.Auth != "" {
			line = info.Auth
		}
		rows = append(rows, plain.Render(line))
	}

	// Model line. Skip when empty OR equal to the legacy "?" sentinel so
	// a fresh boot before the model name is known doesn't render a
	// confusing "? (/model to change)" line (ux1.png feedback).
	if info.Model != "" && info.Model != "?" {
		rows = append(rows, plain.Render(info.Model)+" "+muted.Render("(/model to change)"))
	}

	if info.Cwd != "" {
		rows = append(rows, muted.Render(info.Cwd))
	}

	return rows
}

// colorize applies the per-row gradient to the logo lines.
func colorize(lines []string) []string {
	gradient := style.S.Brand.LogoGradient
	out := make([]string, len(lines))
	for i, line := range lines {
		c := lipgloss.Color(gradient[i%len(gradient)])
		out[i] = lipgloss.NewStyle().Foreground(c).Render(line)
	}
	return out
}

// padBlock right-pads each line to width and appends empty lines until
// the block reaches the target height. Mirrors src/ui/splash.ts.
func padBlock(lines []string, height, width int) []string {
	out := make([]string, height)
	pad := strings.Repeat(" ", width)
	for i := 0; i < height; i++ {
		if i < len(lines) {
			line := lines[i]
			fill := width - lipgloss.Width(line)
			if fill < 0 {
				fill = 0
			}
			out[i] = line + strings.Repeat(" ", fill)
		} else {
			out[i] = pad
		}
	}
	return out
}

// visualWidthMax returns the widest visual width across the given lines.
// Uses lipgloss.Width which handles ANSI escape codes and wide chars.
func visualWidthMax(lines []string) int {
	w := 0
	for _, line := range lines {
		if lw := lipgloss.Width(line); lw > w {
			w = lw
		}
	}
	return w
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
