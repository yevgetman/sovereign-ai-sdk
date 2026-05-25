// Prompt component tests — pin the auto-grow behavior added in
// ux-fixes round 3 (problem1/2/3.png feedback). The textarea-backed
// prompt must report Height() that reflects soft-wrap line count, cap
// at style.S.Prompt.MaxHeight, and shrink back when content is removed.

package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/style"

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
	if got := p.Height(); got > style.S.Prompt.MaxHeight {
		t.Errorf("expected height to cap at %d, got %d", style.S.Prompt.MaxHeight, got)
	}
}

func TestPrompt_HeightCapsAtMax(t *testing.T) {
	p := NewPrompt()
	p.SetWidth(40)
	// A pathologically long string that should wrap to many more than
	// style.S.Prompt.MaxHeight rows. Height() must clamp.
	veryLong := strings.Repeat("xyz ", 1000)
	p.SetValue(veryLong)
	if got := p.Height(); got != style.S.Prompt.MaxHeight {
		t.Errorf("expected height clamped to %d, got %d", style.S.Prompt.MaxHeight, got)
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

func TestPrompt_RegisterPaste_AbstractsMultilineBlock(t *testing.T) {
	// ux-fixes round 4: a paste of >= pasteAbstractMinLines should be
	// replaced with a "[Pasted text #N +M lines]" placeholder.
	p := NewPrompt()
	p.SetWidth(80)
	content := "line one\nline two\nline three"
	if !p.RegisterPaste(content) {
		t.Fatal("expected 3-line paste to be abstracted")
	}
	if !strings.Contains(p.Value(), "[Pasted text #1 +3 lines]") {
		t.Errorf("placeholder missing; value=%q", p.Value())
	}
}

func TestPrompt_RegisterPaste_RejectsShortSingleLine(t *testing.T) {
	// Pastes below the abstraction threshold return false so the
	// caller knows to insert verbatim.
	p := NewPrompt()
	p.SetWidth(80)
	if p.RegisterPaste("yes") {
		t.Errorf("expected short single-line paste to NOT abstract")
	}
}

func TestPrompt_RegisterPaste_AbstractsLongSingleLine(t *testing.T) {
	// A single very long line should still abstract (>= pasteAbstractMinChars).
	p := NewPrompt()
	p.SetWidth(80)
	long := strings.Repeat("x", 300)
	if !p.RegisterPaste(long) {
		t.Errorf("expected 300-char single-line paste to abstract")
	}
	if !strings.Contains(p.Value(), "[Pasted text #1 +1 lines]") {
		t.Errorf("placeholder missing for single-line abstract; value=%q", p.Value())
	}
}

func TestPrompt_ExpandPastes_RoundTrip(t *testing.T) {
	// After RegisterPaste + extra typing, ExpandPastes should restore
	// the full original content so the submit handler ships real
	// text rather than the placeholder string.
	p := NewPrompt()
	p.SetWidth(80)
	original := "alpha\nbeta\ngamma"
	if !p.RegisterPaste(original) {
		t.Fatal("expected paste to abstract")
	}
	p.InsertString(" hello")
	expanded := p.ExpandPastes(p.Value())
	if !strings.Contains(expanded, original) {
		t.Errorf("expand round-trip missing original content; got %q", expanded)
	}
	if !strings.HasSuffix(expanded, " hello") {
		t.Errorf("expand should preserve post-placeholder typing; got %q", expanded)
	}
	if strings.Contains(expanded, "[Pasted text") {
		t.Errorf("expand should remove the placeholder; got %q", expanded)
	}
}

func TestPrompt_ExpandPastes_MultiPastes(t *testing.T) {
	// Two abstracted pastes get distinct ids and both expand correctly.
	p := NewPrompt()
	p.SetWidth(80)
	first := "first\npaste\nblock"
	second := "second\npaste\nblock"
	p.RegisterPaste(first)
	p.InsertString(" then ")
	p.RegisterPaste(second)
	expanded := p.ExpandPastes(p.Value())
	if !strings.Contains(expanded, first) {
		t.Errorf("first paste content missing; got %q", expanded)
	}
	if !strings.Contains(expanded, second) {
		t.Errorf("second paste content missing; got %q", expanded)
	}
}

func TestPrompt_ExpandPastes_BrokenPlaceholderPassesThrough(t *testing.T) {
	// If the user partially edits a placeholder (or types one literally),
	// ExpandPastes should leave the broken / unknown marker as-is.
	p := NewPrompt()
	p.SetWidth(80)
	// Without any RegisterPaste, ExpandPastes is a no-op.
	in := "[Pasted text #1 +5 lines]"
	if got := p.ExpandPastes(in); got != in {
		t.Errorf("expected literal pass-through when no buffers; got %q", got)
	}
	// With one buffer, an out-of-range id is left alone.
	p.RegisterPaste("a\nb\nc")
	in2 := "see [Pasted text #9 +2 lines] above"
	out := p.ExpandPastes(in2)
	if !strings.Contains(out, "#9") {
		t.Errorf("out-of-range placeholder should be preserved; got %q", out)
	}
}

func TestPrompt_Clear_ResetsPasteBuffers(t *testing.T) {
	// Clear() (called on submit) must drop the paste buffers so a
	// stale "#1" from a previous turn doesn't expand for a new
	// composition session.
	p := NewPrompt()
	p.SetWidth(80)
	p.RegisterPaste("a\nb\nc")
	p.Clear()
	expanded := p.ExpandPastes("[Pasted text #1 +3 lines]")
	if !strings.Contains(expanded, "#1") {
		t.Errorf("after Clear, stale buffer should not expand; got %q", expanded)
	}
}
