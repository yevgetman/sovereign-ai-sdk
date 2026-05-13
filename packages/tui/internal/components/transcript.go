// Package components — Transcript: scrollable viewport of message lines.
//
// M2: append-only text buffer with bubbles/viewport scrollback. M3+: each
// message is a typed card (user / assistant / tool) with collapsible state.

package components

import (
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type Transcript struct {
	vp       viewport.Model
	lines    []string
	width    int
	height   int
	atBottom bool
}

func NewTranscript() Transcript {
	vp := viewport.New(80, 20)
	return Transcript{vp: vp, atBottom: true}
}

func (t Transcript) Update(msg tea.Msg) (Transcript, tea.Cmd) {
	var cmd tea.Cmd
	t.vp, cmd = t.vp.Update(msg)
	return t, cmd
}

func (t *Transcript) SetSize(w, h int) {
	t.width = w
	t.height = h
	t.vp.Width = w
	t.vp.Height = h
	t.vp.SetContent(joinLines(t.lines))
}

func (t *Transcript) AppendLine(line string) {
	t.lines = append(t.lines, line)
	t.vp.SetContent(joinLines(t.lines))
	// Only scroll if the viewport has been sized; calling GotoBottom on an
	// unsized viewport panics with slice-out-of-range (bubbles viewport bug
	// surfaced when sse events arrive before WindowSizeMsg).
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
}

func (t Transcript) View() string {
	return t.vp.View()
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	out := lines[0]
	for _, l := range lines[1:] {
		out += "\n" + l
	}
	return out
}
