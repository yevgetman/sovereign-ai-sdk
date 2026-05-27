// Package components — LiveRegion: the bottom-anchored live view
// above the prompt.
//
// ux-fixes round 5 (scroll + selection refactor): the TUI moved off
// bubbletea's alt screen so the terminal's natural scrollback holds
// session history. Wheel scroll + text selection both work without
// the TUI capturing mouse events. Committed transcript content is
// emitted into scrollback via tea.Println; what stays in the live
// View() is only the in-flight streaming card + the thinking
// spinner + a "running command" indicator (when a slash command is
// dispatched). LiveRegion owns that bottom-of-screen mutable region.
//
// Lifecycle in a normal turn:
//
//	user hits Enter            → m.print(echo) commits "» message" to scrollback
//	first text_delta arrives   → live.AppendAssistantDelta("partial")
//	more text_deltas arrive    → live.AppendAssistantDelta(more)
//	tool_use_start arrives     → live.EndAssistantCard() returns the
//	                             rendered card; caller m.print(committed);
//	                             live region clears the streaming buffer
//	tool_result arrives        → caller m.print(toolcard.View()) directly
//	more text_delta arrives    → live.AppendAssistantDelta(next)
//	turn_complete arrives      → live.EndAssistantCard() commits final card;
//	                             caller m.print(committed)
//
// The spinner machinery is parallel: startSpinner sets a frame string
// via SetSpinner; tick events update the frame; clearThinkingIfPending
// fires ClearSpinner. The spinner string sits below any streaming
// card in View() output.

package components

import (
	"strings"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

type LiveRegion struct {
	width   int
	theme   theme.Theme
	stream  *strings.Builder // currentAssistant streaming buffer; nil = no active card
	spinner string           // last-rendered spinner frame, or "" when inactive
	// runningCommand is the "…running /name <args>" indicator that
	// renders while a slash command is awaiting its response. Cleared
	// when the matching commandDispatchedMsg / compactCompleteMsg /
	// compactErrorMsg arrives (the same handlers that print the real
	// output). ux-fixes round 5 — replaces the
	// AppendLine("…running") + RemoveLastLine pattern that worked in
	// the alt-screen viewport era.
	runningCommand string
}

// NewLiveRegion constructs a LiveRegion with the given starting theme.
func NewLiveRegion(t theme.Theme) LiveRegion {
	return LiveRegion{theme: t}
}

// SetWidth records the wrap width used by the markdown renderer on the
// streaming card. App.go's WindowSizeMsg handler calls this.
func (l *LiveRegion) SetWidth(w int) {
	l.width = w
}

// SetTheme swaps the theme used for in-flight rendering. Mid-session
// /theme changes call this; already-committed scrollback retains its
// prior styling (the terminal owns it, can't be re-styled retroactively).
func (l *LiveRegion) SetTheme(t theme.Theme) {
	l.theme = t
}

// AppendAssistantDelta accumulates text into the streaming buffer.
// The first call after a successful EndAssistantCard (or the initial
// nil-stream state) opens a fresh buffer; subsequent calls append.
func (l *LiveRegion) AppendAssistantDelta(delta string) {
	if l.stream == nil {
		l.stream = &strings.Builder{}
	}
	l.stream.WriteString(delta)
}

// HasStreaming reports whether an open streaming card exists. Used by
// turn-boundary handlers to know whether to commit before swapping to
// another live element (tool card, error, etc.).
func (l LiveRegion) HasStreaming() bool {
	return l.stream != nil && l.stream.Len() > 0
}

// EndAssistantCard finalizes the active streaming buffer and returns
// the rendered card string for the caller to print into scrollback.
// Returns (rendered, true) when content was active; ("", false) when
// no card was open (idempotent no-op).
func (l *LiveRegion) EndAssistantCard() (string, bool) {
	if l.stream == nil || l.stream.Len() == 0 {
		l.stream = nil
		return "", false
	}
	body := l.stream.String()
	l.stream = nil
	rendered := render.Markdown(body, l.theme, l.width)
	trimmed := strings.TrimRight(rendered, "\n")
	return trimmed + "\n", true
}

// SetSpinner installs the given line as the live spinner display.
// Caller passes the fully-styled output (e.g., the Spinner component's
// View() result). Replacement is in place; calling SetSpinner with a
// new string overwrites whatever was there.
func (l *LiveRegion) SetSpinner(line string) {
	l.spinner = line
}

// ClearSpinner removes the spinner from the live region.
func (l *LiveRegion) ClearSpinner() {
	l.spinner = ""
}

// SetRunningCommand sets the dim "…running /name args" indicator that
// stays visible while the dispatched slash command is in flight. Pass
// "" to clear; matching commandDispatchedMsg / compactCompleteMsg /
// compactErrorMsg handlers clear it when they print the actual output.
func (l *LiveRegion) SetRunningCommand(line string) {
	l.runningCommand = line
}

// View returns the composited live region:
//
//	<streaming card>     — current assistant content, markdown-rendered
//	<running command>    — dim "…running /name args" while awaiting
//	<spinner>            — branded thinking indicator
//
// Empty when nothing is live. Caller appends prompt + status below.
func (l LiveRegion) View() string {
	var parts []string
	if l.stream != nil && l.stream.Len() > 0 {
		parts = append(parts, render.Markdown(l.stream.String(), l.theme, l.width))
	}
	if l.runningCommand != "" {
		parts = append(parts, l.runningCommand)
	}
	if l.spinner != "" {
		parts = append(parts, l.spinner)
	}
	return strings.Join(parts, "")
}
