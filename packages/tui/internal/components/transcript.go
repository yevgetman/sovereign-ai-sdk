// Package components — Transcript: scrollable viewport of message lines.
//
// M2: append-only text buffer with bubbles/viewport scrollback. M3+: each
// message is a typed card (user / assistant / tool) with collapsible state.
// M9 T3: assistant text_delta events stream into a buffered current-card
// that re-renders through render.Markdown on every delta; non-text events
// finalize the card via EndAssistantCard so the next text_delta starts a
// new one.

package components

import (
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

type Transcript struct {
	vp       viewport.Model
	lines    []string
	width    int
	height   int
	atBottom bool

	// M9 T3 — buffered current-assistant card. Streaming text_delta events
	// append to currentAssistant and re-render lines[currentAssistantIdx]
	// in place. nil means no in-progress card; the next text_delta starts
	// one. theme drives the markdown style selection.
	currentAssistant    *strings.Builder
	currentAssistantIdx int
	theme               theme.Theme
}

func NewTranscript(th theme.Theme) Transcript {
	vp := viewport.New(80, 20)
	return Transcript{vp: vp, atBottom: true, theme: th}
}

func (t Transcript) Update(msg tea.Msg) (Transcript, tea.Cmd) {
	var cmd tea.Cmd
	t.vp, cmd = t.vp.Update(msg)
	return t, cmd
}

func (t *Transcript) SetSize(w, h int) {
	t.width = w
	// On tiny terminals where WindowSizeMsg.Height < statusH + promptH the
	// caller hands us a negative height. Pass that into bubbles' viewport
	// and we get a slice-out-of-range panic. Clamp to 0 so the viewport
	// shrinks to nothing but doesn't crash the UI.
	if h < 0 {
		h = 0
	}
	t.height = h
	t.vp.Width = w
	t.vp.Height = h
	t.vp.SetContent(joinLines(t.lines))
}

// SetTheme swaps the theme used for in-progress markdown rendering and
// re-renders the current assistant card (if any). Called from app.go
// when the user runs /theme <name>.
func (t *Transcript) SetTheme(th theme.Theme) {
	t.theme = th
	if t.currentAssistant != nil && t.currentAssistantIdx < len(t.lines) {
		t.lines[t.currentAssistantIdx] = render.Markdown(t.currentAssistant.String(), t.theme, t.width)
		t.vp.SetContent(joinLines(t.lines))
	}
}

func (t *Transcript) AppendLine(line string) {
	// Any non-streamed append finalizes the in-progress assistant card so
	// the next text_delta starts fresh. Callers that want to keep streaming
	// open should use AppendAssistantDelta instead.
	t.currentAssistant = nil
	t.lines = append(t.lines, line)
	t.vp.SetContent(joinLines(t.lines))
	// Only scroll if the viewport has been sized; calling GotoBottom on an
	// unsized viewport panics with slice-out-of-range (bubbles viewport bug
	// surfaced when sse events arrive before WindowSizeMsg).
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
}

// AppendAssistantDelta appends a text_delta to the in-progress assistant
// card and re-renders the line through render.Markdown. The first call
// starts a new card; subsequent calls update the same line in place. M9 T3.
func (t *Transcript) AppendAssistantDelta(delta string) {
	if t.currentAssistant == nil {
		t.currentAssistant = &strings.Builder{}
		t.currentAssistantIdx = len(t.lines)
		t.lines = append(t.lines, "")
	}
	t.currentAssistant.WriteString(delta)
	rendered := render.Markdown(t.currentAssistant.String(), t.theme, t.width)
	t.lines[t.currentAssistantIdx] = rendered
	t.vp.SetContent(joinLines(t.lines))
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
}

// EndAssistantCard finalizes the in-progress assistant card. Subsequent
// AppendAssistantDelta calls start a new card. Called from app.go on
// turn_complete, tool_use_start, tool_result, and any other non-text event
// that interrupts the streaming assistant. No-op when no card is in-progress.
func (t *Transcript) EndAssistantCard() {
	t.currentAssistant = nil
	t.currentAssistantIdx = 0
}

// RemoveLastLine pops the most recent transcript line and re-renders. Used
// to clear the dim "…thinking" placeholder when the first response event
// for a turn arrives. No-op when the buffer is empty.
func (t *Transcript) RemoveLastLine() {
	if len(t.lines) == 0 {
		return
	}
	t.lines = t.lines[:len(t.lines)-1]
	// If the removed line was the in-progress assistant card, drop the buffer.
	if t.currentAssistant != nil && t.currentAssistantIdx >= len(t.lines) {
		t.currentAssistant = nil
	}
	t.vp.SetContent(joinLines(t.lines))
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
}

func (t Transcript) View() string {
	return t.vp.View()
}

func joinLines(lines []string) string {
	return strings.Join(lines, "\n")
}
