// Prompt component tests — pin the auto-grow behavior added in
// ux-fixes round 3 (problem1/2/3.png feedback). The textarea-backed
// prompt must report Height() that reflects soft-wrap line count, cap
// at maxPromptHeight, and shrink back when content is removed.

package components

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPrompt_DefaultsToHeightOne(t *testing.T) {
	p := NewPrompt()
	p.SetWidth(80)
	if got := p.Height(); got != 1 {
		t.Errorf("expected fresh prompt at height 1, got %d", got)
	}
}

func TestPrompt_HeightGrowsWithWrap(t *testing.T) {
	p := NewPrompt()
	p.SetWidth(40) // narrow box → wrap kicks in earlier
	// Inject a long single-paragraph string via SetValue (avoids the
	// tea.KeyMsg dispatch path).
	long := strings.Repeat("abc def ", 30) // ~240 chars
	p.SetValue(long)
	if got := p.Height(); got < 2 {
		t.Errorf("expected long content to wrap to >= 2 rows at width 40, got %d", got)
	}
	if got := p.Height(); got > maxPromptHeight {
		t.Errorf("expected height to cap at %d, got %d", maxPromptHeight, got)
	}
}

func TestPrompt_HeightCapsAtMax(t *testing.T) {
	p := NewPrompt()
	p.SetWidth(40)
	// A pathologically long string that should wrap to many more than
	// maxPromptHeight rows. Height() must clamp.
	veryLong := strings.Repeat("xyz ", 1000)
	p.SetValue(veryLong)
	if got := p.Height(); got != maxPromptHeight {
		t.Errorf("expected height clamped to %d, got %d", maxPromptHeight, got)
	}
}

func TestPrompt_HeightShrinksAfterClear(t *testing.T) {
	p := NewPrompt()
	p.SetWidth(40)
	p.SetValue(strings.Repeat("abc def ", 30))
	if p.Height() < 2 {
		t.Fatalf("test precondition: long content should wrap to >= 2 rows")
	}
	p.Clear()
	if got := p.Height(); got != 1 {
		t.Errorf("expected height to reset to 1 after Clear, got %d", got)
	}
}

func TestPrompt_HeightCountsLogicalNewlines(t *testing.T) {
	// Multi-paragraph composition via embedded newlines (Alt+Enter
	// inserts these in the live textarea — SetValue with literal "\n"
	// mirrors the effect).
	p := NewPrompt()
	p.SetWidth(80)
	p.SetValue("line one\nline two\nline three")
	if got := p.Height(); got != 3 {
		t.Errorf("expected 3 rows for 3 newline-separated paragraphs at width 80, got %d", got)
	}
}

func TestPrompt_ViewRendersBoxBorder(t *testing.T) {
	p := NewPrompt()
	p.SetWidth(80)
	view := p.View()
	// The lipgloss rounded border emits "╭" at the top-left corner.
	// Lipgloss may strip styles in non-TTY but the literal character
	// remains in the output.
	if !strings.Contains(view, "╭") || !strings.Contains(view, "╰") {
		t.Errorf("expected rounded box corners in prompt View, got:\n%s", view)
	}
}

func TestPrompt_HeightUpdatesAfterTypedRune(t *testing.T) {
	// Dispatch a keystroke through Update to verify the height tracking
	// hook fires correctly (not just via SetValue). This is the path
	// the live TUI takes on every keypress.
	p := NewPrompt()
	p.SetWidth(40)
	// Type enough characters to definitely wrap.
	for _, r := range strings.Repeat("x", 100) {
		p, _ = p.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	if got := p.Height(); got < 2 {
		t.Errorf("after typing 100 chars at width 40, expected >= 2 rows, got %d", got)
	}
}
