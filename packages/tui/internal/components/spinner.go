// Package components — Spinner: branded thinking indicator.
//
// Animates a Braille rotation frame through the splash's cyan→blue
// gradient so the spinner reads as part of the SOV brand cue rather
// than as generic terminal output. M11.2 — replaces the static
// "…thinking" placeholder that pre-M11.2 sat alone under the user's
// input during the 1-3s network wait before the first text_delta.
//
// Three animations layer simultaneously: the Braille glyph rotates
// (8 heavy-Braille frames), the color advances through the 4-color
// gradient (cyan / sapphire / blue / lavender), and the trailing
// ellipsis grows from "." to "..." (3-state cycle). 8 × 4 × 3 = 96
// distinct visual states before the loop repeats, which keeps the
// animation feeling alive on a slow LLM response without the eye
// locking onto a single pattern.
//
// ux-fixes round 2 — the label was previously "thinking" in dim
// italic. Capitalized to "Thinking", set to bold (no Foreground so it
// inherits terminal default bright fg), heavier Braille frames
// (⣾⣽⣻⢿⡿⣟⣯⣷ — 8-dot fully-filled Braille reads bigger than the prior
// 6-dot set), animated growing-dot ellipsis, and a leading + trailing
// blank line so the spinner reads as its own beat rather than being
// crushed up against the surrounding tool cards.

package components

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/style"
)

// thinkingSpinnerFrames is the Braille rotation used by the thinking
// indicator. Bottom-weighted glyphs sit at the same vertical level as
// text and read as cleanly aligned.
var thinkingSpinnerFrames = []string{
	"⢀", "⣀", "⡀", "⡄", "⠄", "⠤", "⠠", "⢠",
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

// View renders the spinner as "<colored-glyph> <bold-label>" wrapped
// with blank lines top + bottom so the indicator reads as its own
// breath in the transcript flow rather than crashing into the
// surrounding cards. The glyph picks up the current gradient color
// and bold attribute; the label is bold + no Foreground so it
// inherits terminal default fg (the M11.10 "brightest reliable" rule).
//
// When a non-empty label is passed, the first letter is capitalized
// and a growing ellipsis (".", "..", "...") is appended based on the
// frame counter so the textual half of the indicator also animates.
// Pass an empty label to render the glyph alone (with the same
// surrounding blank lines for layout consistency).
func (s Spinner) View(label string) string {
	gradient := style.S.Brand.SpinnerGradient
	glyphIdx := s.frame % len(thinkingSpinnerFrames)
	colorIdx := (s.frame / style.S.Spinner.ColorCycleStride) % len(gradient)
	glyph := lipgloss.NewStyle().
		Foreground(lipgloss.Color(gradient[colorIdx])).
		Bold(true).
		Render(thinkingSpinnerFrames[glyphIdx])
	if label == "" {
		return "\n" + glyph + "\n"
	}
	dotCount := 1 + (s.frame/style.S.Spinner.DotCycleStride)%3
	displayLabel := capitalizeFirst(label) + strings.Repeat(".", dotCount)
	labelStyle := lipgloss.NewStyle().Bold(true)
	return "\n" + glyph + style.S.Spinner.GlyphSpacing + labelStyle.Render(displayLabel) + "\n"
}

// capitalizeFirst returns label with its first byte uppercased. Used
// to surface "Thinking" rather than "thinking" without forcing every
// caller to pre-capitalize. Empty input returns empty.
func capitalizeFirst(label string) string {
	if label == "" {
		return label
	}
	return strings.ToUpper(label[:1]) + label[1:]
}
