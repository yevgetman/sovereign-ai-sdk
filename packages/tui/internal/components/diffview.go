// Package components — DiffView: focused-state component that owns the
// active-hunk cursor for `j`/`k` navigation. When focused (app.go sets
// SetFocused(true) on Ctrl+]), j/k cycle through the parsed hunks. When
// unfocused, View renders without any hunk highlight (a flat dump).
//
// ADR M9-07: separate from the M8 /expand ring buffer. /expand re-renders
// a tool block in place; DiffView owns scroll-style navigation within an
// expanded diff.

package components

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

type DiffView struct {
	Hunks      []render.Hunk
	activeHunk int
	focused    bool
	theme      theme.Theme
}

// NewDiffView parses the diff text into hunks and returns a DiffView with
// activeHunk=0 and focused=false. The caller (toolcard.go) takes a pointer
// to this value so app.go can SetFocused(true) on Ctrl+] and Update() with
// j/k key events.
func NewDiffView(text string, t theme.Theme) DiffView {
	return DiffView{
		Hunks:      render.ParseDiff(text),
		activeHunk: 0,
		theme:      t,
	}
}

// SetFocused gates whether j/k key events advance the cursor.
func (dv *DiffView) SetFocused(b bool) { dv.focused = b }

// Focused reports the current focus state. Used by app.go for routing.
func (dv DiffView) Focused() bool { return dv.focused }

// ActiveHunk returns the current cursor position. Bounds-clamped to
// [0, len(Hunks)-1].
func (dv DiffView) ActiveHunk() int { return dv.activeHunk }

// HasHunks reports whether any hunks were parsed. Useful for the toolcard
// to skip the diff render path when ParseDiff returned nothing.
func (dv DiffView) HasHunks() bool { return len(dv.Hunks) > 0 }

// Update handles j/k when focused. Returns the next state value.
// Bounds-clamped: j past last hunk stays at last; k before first stays
// at first. Ignored when unfocused.
func (dv DiffView) Update(msg tea.Msg) DiffView {
	if !dv.focused {
		return dv
	}
	keyMsg, ok := msg.(tea.KeyMsg)
	if !ok {
		return dv
	}
	switch keyMsg.String() {
	case "j":
		if dv.activeHunk+1 < len(dv.Hunks) {
			dv.activeHunk++
		}
	case "k":
		if dv.activeHunk > 0 {
			dv.activeHunk--
		}
	}
	return dv
}

// View renders all hunks with the active one highlighted (only when focused).
func (dv DiffView) View(width int) string {
	active := -1
	if dv.focused {
		active = dv.activeHunk
	}
	return render.RenderHunks(dv.Hunks, active, dv.theme, width)
}
