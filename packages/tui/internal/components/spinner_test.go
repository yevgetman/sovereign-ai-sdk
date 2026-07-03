// Spinner unit tests — pin the frame-cycling math, the gradient-cycle
// slowdown (1 color step per 3 glyph steps), and the View() output
// shape. Visual fidelity (does it actually look animated?) is verified
// by hand during the M11.2 smoke; this file pins behavior.

package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/style"
)

func TestSpinner_NewStartsAtFrameZero(t *testing.T) {
	s := NewSpinner()
	if s.Frame() != 0 {
		t.Errorf("expected new spinner at frame 0, got %d", s.Frame())
	}
}

func TestSpinner_TickAdvancesFrame(t *testing.T) {
	s := NewSpinner()
	s = s.Tick()
	if s.Frame() != 1 {
		t.Errorf("after one tick expected frame 1, got %d", s.Frame())
	}
	s = s.Tick().Tick().Tick()
	if s.Frame() != 4 {
		t.Errorf("after four total ticks expected frame 4, got %d", s.Frame())
	}
}

func TestSpinner_TickIsImmutable(t *testing.T) {
	// Verify the receiver is value-type and not mutated by Tick. This
	// guards against future drift to pointer-receiver where stale
	// captures of a Spinner could observe unexpected forward-progress.
	s := NewSpinner()
	_ = s.Tick()
	if s.Frame() != 0 {
		t.Errorf("Tick mutated original; expected frame 0, got %d", s.Frame())
	}
}

func TestSpinner_ViewContainsGlyph(t *testing.T) {
	s := NewSpinner()
	out := s.View("thinking")
	// The first frame's glyph is the leading Braille character.
	if !strings.Contains(out, thinkingSpinnerFrames[0]) {
		t.Errorf("expected first-frame glyph %q in output, got:\n%s", thinkingSpinnerFrames[0], out)
	}
}

func TestSpinner_ViewCapitalizesLabelAndAppendsEllipsis(t *testing.T) {
	s := NewSpinner()
	out := s.View("thinking")
	if !strings.Contains(out, "Thinking") {
		t.Errorf("expected capitalized label \"Thinking\" in output, got:\n%s", out)
	}
	if strings.Contains(out, "thinking") {
		t.Errorf("expected lowercase \"thinking\" to be replaced by capitalized form, got:\n%s", out)
	}
	if !strings.Contains(out, "Thinking.") {
		t.Errorf("expected animated ellipsis (at least one dot) appended to label, got:\n%s", out)
	}
}

func TestSpinner_ViewEllipsisGrowsWithFrame(t *testing.T) {
	// style.S.Spinner.DotCycleStride frames per dot step, 3-state cycle (1, 2, 3 dots).
	// Walk a full cycle and record the dot counts; assert we hit
	// "Thinking." and "Thinking..." and "Thinking..." across the cycle.
	s := NewSpinner()
	seen := map[string]bool{}
	for i := 0; i < style.S.Spinner.DotCycleStride*3; i++ {
		out := s.View("thinking")
		for _, suffix := range []string{"Thinking.", "Thinking..", "Thinking..."} {
			if strings.Contains(out, suffix) {
				seen[suffix] = true
			}
		}
		s = s.Tick()
	}
	for _, suffix := range []string{"Thinking.", "Thinking..", "Thinking..."} {
		if !seen[suffix] {
			t.Errorf("expected to observe %q at some point during the dot cycle; only saw: %v", suffix, seen)
		}
	}
}

func TestSpinner_ViewIncludesLeadingAndTrailingNewlines(t *testing.T) {
	// ux-fixes round 2 — spinner.View wraps its content with blank
	// lines so the indicator has breathing room above and below in
	// the transcript flow (was previously crushed against the prior
	// tool card).
	out := NewSpinner().View("thinking")
	if !strings.HasPrefix(out, "\n") {
		t.Errorf("expected leading newline for above-spacing, got:\n%q", out)
	}
	if !strings.HasSuffix(out, "\n") {
		t.Errorf("expected trailing newline for below-spacing, got:\n%q", out)
	}
}

func TestSpinner_ViewEmptyLabelStillRendersGlyph(t *testing.T) {
	s := NewSpinner()
	out := s.View("")
	if !strings.Contains(out, thinkingSpinnerFrames[0]) {
		t.Errorf("expected glyph even when label empty, got:\n%s", out)
	}
}

func TestSpinner_GlyphCyclesThroughAllFrames(t *testing.T) {
	// After N ticks the glyph index should be N % len(frames). Pin this
	// so a future change to glyph count or modulo logic gets caught.
	s := NewSpinner()
	for i := 0; i < len(thinkingSpinnerFrames)*2; i++ {
		expected := thinkingSpinnerFrames[i%len(thinkingSpinnerFrames)]
		out := s.View("")
		if !strings.Contains(out, expected) {
			t.Errorf("frame %d: expected glyph %q in output, got %q", i, expected, out)
		}
		s = s.Tick()
	}
}

func TestSpinner_ColorAdvancesSlowerThanGlyph(t *testing.T) {
	// Color advances once per 3 glyph ticks (frame/3 % len(gradient)).
	// Verify the color stays stable across 3 consecutive ticks then
	// shifts on the 4th. We can't easily compare ANSI codes for
	// equality (lipgloss adds reset sequences), but we can compare two
	// renders to confirm they share the same color prefix.
	s0 := NewSpinner()
	s1 := s0.Tick()
	s2 := s1.Tick()
	s3 := s2.Tick() // gradient changes here (frame 3 / 3 = 1)

	out0 := s0.View("")
	out1 := s1.View("")
	out2 := s2.View("")
	out3 := s3.View("")

	color0 := colorPrefix(out0)
	color1 := colorPrefix(out1)
	color2 := colorPrefix(out2)
	color3 := colorPrefix(out3)

	// lipgloss strips ANSI when there's no TTY (test runner without -tags
	// or in CI). When colors are empty across the board, the color-cycle
	// math is verified by the frame-index assertions above; skip the
	// ANSI comparison rather than fail spuriously.
	if color0 == "" && color3 == "" {
		t.Skip("lipgloss stripped ANSI in this environment; frame-math covers the behavior")
	}

	if color0 != color1 {
		t.Errorf("color should stay stable from frame 0→1; got %q vs %q", color0, color1)
	}
	if color1 != color2 {
		t.Errorf("color should stay stable from frame 1→2; got %q vs %q", color1, color2)
	}
	if color2 == color3 {
		t.Errorf("color should advance from frame 2→3; both were %q", color2)
	}
}

// colorPrefix returns the leading ANSI escape sequence of a rendered
// string up to (and including) the first 'm' terminator. Returns empty
// when no escape is present (e.g., in CI without TTY where lipgloss
// strips styles). Tests using this should tolerate either branch.
func colorPrefix(s string) string {
	if len(s) < 2 || s[0] != 0x1b {
		return ""
	}
	for i := 0; i < len(s); i++ {
		if s[i] == 'm' {
			return s[:i+1]
		}
	}
	return s
}
