// Package components — Spinner: branded thinking indicator.
//
// Animates a Braille rotation frame through the splash's cyan→blue
// gradient so the spinner reads as part of the SOV brand cue rather
// than as generic terminal output. M11.2 — replaces the static
// "…thinking" placeholder that pre-M11.2 sat alone under the user's
// input during the 1-3s network wait before the first text_delta.
//
// Two animations layer simultaneously: the Braille glyph rotates
// (10 frames) and the color advances through the 4-color gradient
// (cyan / sapphire / blue / lavender). 10 × 4 = 40 distinct visual
// states before the loop repeats, which keeps the animation feeling
// alive on a slow LLM response without the eye locking onto a single
// pattern.

package components

import (
	"github.com/charmbracelet/lipgloss"
)

// thinkingSpinnerFrames is the Braille rotation used by the thinking indicator.
// Mirrors the StatusLine's spinner for visual consistency between the
// status bar (streaming spinner) and the transcript (thinking
// indicator). Both code paths advance independently — each holds its
// own frame counter.
var thinkingSpinnerFrames = []string{
	"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
}

// thinkingSpinnerGradient cycles through the same 4-anchor palette the
// splash logo uses (blue → teal → purple → pink). The colors don't
// depend on the active theme — the spinner is a brand cue, like the
// splash logo, and reads identically on Catppuccin Mocha (dark),
// Latte (light), Tokyo Night, and any user TOML theme. Picks the
// brightest hex from each anchor band so the rotating glyph stays
// vivid across the full color sweep.
var thinkingSpinnerGradient = []lipgloss.Color{
	lipgloss.Color("#4f8fff"), // electric blue
	lipgloss.Color("#22d3ee"), // cyan-teal
	lipgloss.Color("#a78bfa"), // soft purple
	lipgloss.Color("#ec4899"), // pink
}

// Spinner is an immutable snapshot of the spinner's frame state.
// Callers advance via .Tick() which returns a new Spinner; the
// View() output is a styled string ready to drop into the transcript.
type Spinner struct {
	frame int
}

// NewSpinner returns a fresh spinner at frame 0.
func NewSpinner() Spinner {
	return Spinner{}
}

// Tick returns the next-frame Spinner. The Braille rotation advances
// by one and the gradient color advances by one — they're independent
// counters that share a single frame integer (gradient = frame/3 mod
// len(gradient), giving the color a slightly slower cycle than the
// glyph so the spinner feels less "flashy" while still color-shifting).
func (s Spinner) Tick() Spinner {
	return Spinner{frame: s.frame + 1}
}

// Frame returns the current frame number — useful for tests.
func (s Spinner) Frame() int {
	return s.frame
}

// View renders the spinner as "<colored-glyph> <muted-label>" suitable
// for direct insertion into the transcript. The glyph picks up the
// current gradient color; the label is dim-italic to match the prior
// "…thinking" aesthetic. Pass an empty label to render the glyph alone.
func (s Spinner) View(label string) string {
	glyphIdx := s.frame % len(thinkingSpinnerFrames)
	colorIdx := (s.frame / 3) % len(thinkingSpinnerGradient)
	glyph := lipgloss.NewStyle().
		Foreground(thinkingSpinnerGradient[colorIdx]).
		Bold(true).
		Render(thinkingSpinnerFrames[glyphIdx])
	if label == "" {
		return glyph
	}
	labelStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("#9399b2")). // Catppuccin overlay2 — muted but readable
		Italic(true)
	return glyph + " " + labelStyle.Render(label)
}
