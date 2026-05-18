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
	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/render"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

type Transcript struct {
	vp        viewport.Model
	lines     []string
	width     int
	maxHeight int // M11.3: cap on viewport height; viewport sizes to min(content, maxHeight)
	height    int // M11.3: actual viewport height after sizing — equals min(content, maxHeight)
	atBottom  bool

	// M9 T3 — buffered current-assistant card. Streaming text_delta events
	// append to currentAssistant and re-render lines[currentAssistantIdx]
	// in place. nil means no in-progress card; the next text_delta starts
	// one. theme drives the markdown style selection.
	currentAssistant    *strings.Builder
	currentAssistantIdx int
	theme               theme.Theme

	// M9.6 T1 — tool-card retention for click-to-toggle. AppendLineAsCard
	// stores the original ToolCard struct keyed by its line index in
	// `lines`. ToggleCardExpanded looks up the card, flips Expanded, and
	// re-renders that single line.
	toolCards map[int]ToolCard
}

func NewTranscript(th theme.Theme) Transcript {
	vp := viewport.New(80, 20)
	return Transcript{vp: vp, atBottom: true, theme: th, toolCards: map[int]ToolCard{}}
}

func (t Transcript) Update(msg tea.Msg) (Transcript, tea.Cmd) {
	var cmd tea.Cmd
	t.vp, cmd = t.vp.Update(msg)
	return t, cmd
}

// SetSize stores the maximum height budget the caller (app.go's
// WindowSizeMsg handler) can spare for the transcript. The viewport's
// actual height is computed as min(content, maxHeight) so the prompt
// floats just below the content until enough is appended to fill the
// budget. M11.3 — the change from "viewport is always maxHeight tall"
// to "viewport sizes to content" is what makes the input bar follow
// immediately after the splash instead of being anchored at the bottom
// of the terminal.
func (t *Transcript) SetSize(w, h int) {
	t.width = w
	// On tiny terminals where WindowSizeMsg.Height < statusH + promptH the
	// caller hands us a negative height. Clamp the max to 0 so the
	// viewport shrinks to nothing but doesn't crash the UI.
	if h < 0 {
		h = 0
	}
	t.maxHeight = h
	t.vp.Width = w
	t.rebuildHeight()
}

// rebuildHeight reapplies the size-to-content policy after a content
// change. vp.Height = min(contentHeight, maxHeight). Called from
// every append/update path so the prompt can immediately follow new
// content. M11.3.
func (t *Transcript) rebuildHeight() {
	content := joinLines(t.lines)
	contentHeight := 0
	if content != "" {
		contentHeight = lipgloss.Height(content)
	}
	h := contentHeight
	if h > t.maxHeight {
		h = t.maxHeight
	}
	if h < 0 {
		h = 0
	}
	t.height = h
	t.vp.Height = h
	t.vp.SetContent(content)
}

// ContentHeight returns the total visual height of the transcript's
// lines (sum of lipgloss.Height for each line). Useful for callers
// laying out below the transcript who need to know how many rows the
// transcript actually occupies. M11.3.
func (t Transcript) ContentHeight() int {
	content := joinLines(t.lines)
	if content == "" {
		return 0
	}
	return lipgloss.Height(content)
}

// SetTheme swaps the theme used for in-progress markdown rendering and
// re-renders the current assistant card (if any). Called from app.go
// when the user runs /theme <name>.
func (t *Transcript) SetTheme(th theme.Theme) {
	t.theme = th
	if t.currentAssistant != nil && t.currentAssistantIdx < len(t.lines) {
		t.lines[t.currentAssistantIdx] = render.Markdown(t.currentAssistant.String(), t.theme, t.width)
		t.rebuildHeight()
	}
}

func (t *Transcript) AppendLine(line string) {
	// Any non-streamed append finalizes the in-progress assistant card so
	// the next text_delta starts fresh. Callers that want to keep streaming
	// open should use AppendAssistantDelta instead.
	t.currentAssistant = nil
	t.lines = append(t.lines, line)
	t.rebuildHeight()
	// Only scroll if the viewport has been sized; calling GotoBottom on an
	// unsized viewport panics with slice-out-of-range (bubbles viewport bug
	// surfaced when sse events arrive before WindowSizeMsg).
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
}

// AppendUserLine renders a "» <text>" marker styled with the theme's
// Primary color (bold) so user inputs are immediately distinguishable
// from model responses, dim system messages, and tool cards. Centralizes
// the styling so every call site stays in sync. M11.1.
//
// M11.8 — body uses ANSI 16-color "15" (universal bright-white) on
// dark themes. Hex values were getting quantized down to dim greys
// in tmux 256-color mode; color "15" renders identically and brightly
// across every profile. Light themes use theme.Foreground for proper
// contrast against the light background.
func (t *Transcript) AppendUserLine(text string) {
	marker := lipgloss.NewStyle().Foreground(t.theme.Primary).Bold(true).Render("» ")
	bodyColor := lipgloss.Color("15")
	if t.theme.Name == "light" {
		bodyColor = t.theme.Foreground
	}
	body := lipgloss.NewStyle().Foreground(bodyColor).Render(text)
	t.AppendLine(marker + body)
}

// AppendLiveLine appends a line and records its index so subsequent
// UpdateLiveLine calls can re-render it in place without disturbing
// surrounding content. Returns the line's index for the caller to
// retain. M11.2 — drives the thinking spinner.
//
// Mirrors AppendAssistantDelta's in-place update pattern but without
// the markdown-rendering pipeline; the live line is a fully-rendered
// string the caller produces (e.g., the spinner's View output).
func (t *Transcript) AppendLiveLine(line string) int {
	t.currentAssistant = nil
	idx := len(t.lines)
	t.lines = append(t.lines, line)
	t.rebuildHeight()
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
	return idx
}

// UpdateLiveLine replaces the content at lineIdx with the new string
// and re-renders the viewport. No-op when lineIdx is out of range
// (e.g., when ClearLiveLine has already popped it). M11.2.
func (t *Transcript) UpdateLiveLine(lineIdx int, line string) {
	if lineIdx < 0 || lineIdx >= len(t.lines) {
		return
	}
	t.lines[lineIdx] = line
	t.rebuildHeight()
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
	t.rebuildHeight()
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
	t.rebuildHeight()
	if t.atBottom && t.width > 0 && t.height > 0 {
		t.vp.GotoBottom()
	}
}

func (t Transcript) View() string {
	return t.vp.View()
}

// AppendLineAsCard records the original ToolCard alongside the rendered
// line so ToggleCardExpanded can re-render in place. M9.6 T1. Falls
// through to AppendLine for the actual append.
func (t *Transcript) AppendLineAsCard(card ToolCard) {
	rendered := card.View(t.width)
	lineIdx := len(t.lines)
	t.AppendLine(rendered)
	t.toolCards[lineIdx] = card
}

// ClickAt returns the line index whose rendered Y-range contains the
// click. The click Y is in viewport-relative coordinates (0 = top of
// visible region). We add the viewport's YOffset to translate to the
// absolute Y in the full content, then walk the cumulative line heights.
// Returns (-1, false) when the click doesn't hit any line.
//
// Used by app.go's mouse-click handler (M9.6 T1).
func (t Transcript) ClickAt(y int) (int, bool) {
	if y < 0 {
		return -1, false
	}
	absoluteY := y + t.vp.YOffset
	cumulative := 0
	for i, line := range t.lines {
		h := lipgloss.Height(line)
		if h <= 0 {
			h = 1
		}
		if absoluteY >= cumulative && absoluteY < cumulative+h {
			return i, true
		}
		cumulative += h
	}
	return -1, false
}

// ToggleCardExpanded flips the Expanded field of the card at lineIdx and
// re-renders that line. No-op when lineIdx doesn't reference a stored
// card (e.g., user clicked a non-card line). M9.6 T1.
func (t *Transcript) ToggleCardExpanded(lineIdx int) {
	card, ok := t.toolCards[lineIdx]
	if !ok {
		return
	}
	card.Expanded = !card.Expanded
	t.toolCards[lineIdx] = card
	if lineIdx >= 0 && lineIdx < len(t.lines) {
		t.lines[lineIdx] = card.View(t.width)
		t.rebuildHeight()
	}
}

func joinLines(lines []string) string {
	return strings.Join(lines, "\n")
}
