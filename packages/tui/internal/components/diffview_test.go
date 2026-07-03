package components

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestDiffViewParseHunks(t *testing.T) {
	dv := NewDiffView("@@ -1 +1 @@\n+added\n", theme.Dark())
	if !dv.HasHunks() {
		t.Error("expected at least one hunk")
	}
	if len(dv.Hunks) != 1 {
		t.Errorf("got %d hunks, want 1", len(dv.Hunks))
	}
}

func TestDiffViewNoHunks(t *testing.T) {
	dv := NewDiffView("not a diff", theme.Dark())
	if dv.HasHunks() {
		t.Error("expected no hunks for non-diff input")
	}
}

func TestDiffViewJCyclesForward(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n@@ c\n", theme.Dark())
	dv.SetFocused(true)
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if dv.ActiveHunk() != 1 {
		t.Errorf("j: got activeHunk=%d want 1", dv.ActiveHunk())
	}
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if dv.ActiveHunk() != 2 {
		t.Errorf("jj: got activeHunk=%d want 2", dv.ActiveHunk())
	}
}

func TestDiffViewJClampsAtLastHunk(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n", theme.Dark())
	dv.SetFocused(true)
	for i := 0; i < 5; i++ {
		dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	}
	if dv.ActiveHunk() != 1 {
		t.Errorf("clamp at last: got %d want 1", dv.ActiveHunk())
	}
}

func TestDiffViewKClampsAtFirstHunk(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n", theme.Dark())
	dv.SetFocused(true)
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if dv.ActiveHunk() != 0 {
		t.Errorf("k at 0: got %d want 0", dv.ActiveHunk())
	}
}

func TestDiffViewKBackwardCycles(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n@@ c\n", theme.Dark())
	dv.SetFocused(true)
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if dv.ActiveHunk() != 1 {
		t.Errorf("jjk: got %d want 1", dv.ActiveHunk())
	}
}

func TestDiffViewIgnoresKeysWhenUnfocused(t *testing.T) {
	dv := NewDiffView("@@ a\n@@ b\n", theme.Dark())
	dv = dv.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if dv.ActiveHunk() != 0 {
		t.Errorf("unfocused: got %d want 0", dv.ActiveHunk())
	}
}

func TestDiffViewFocusedRendersMarker(t *testing.T) {
	dv := NewDiffView("@@ a\n+x\n", theme.Dark())
	dv.SetFocused(true)
	out := dv.View(80)
	if !strings.Contains(out, "▶") {
		t.Errorf("focused view should have ▶ marker: %q", out)
	}
}

func TestDiffViewUnfocusedNoMarker(t *testing.T) {
	dv := NewDiffView("@@ a\n+x\n", theme.Dark())
	out := dv.View(80)
	if strings.Contains(out, "▶") {
		t.Errorf("unfocused view should not have ▶ marker: %q", out)
	}
}
