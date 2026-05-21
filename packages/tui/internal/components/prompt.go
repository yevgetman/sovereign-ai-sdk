// Package components — Prompt: bottom input row.
//
// ux-fixes round 3: Prompt now wraps a multi-line textarea so the input
// box auto-grows vertically as the user types past the visible width
// (problem1/2/3.png feedback). The pre-round-3 implementation used a
// single-line textinput whose visible window scrolled horizontally
// once content exceeded width — the box stayed at two rows and the
// leading characters of the first row visibly disappeared off the
// left as the user kept typing.
//
// Multi-line newlines: Enter submits the message (intercepted by
// app.go BEFORE the prompt update fires) — Alt+Enter inserts a real
// newline so users can compose multi-paragraph prompts (Claude Code
// convention). Ctrl+J is the same as Alt+Enter via the textarea's
// default keymap.
//
// Layout: the textarea sits inside a rounded lipgloss box with 1
// column of horizontal padding. The box height = textarea height + 2
// for the top + bottom border. Total visible rows is reported via
// Height() so app.go's layout can size the transcript above the
// prompt to fill remaining terminal height.

package components

import (
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// maxPromptHeight caps the textarea's visible row count. Beyond this,
// the textarea scrolls internally (the cursor remains visible). 8
// rows is generous enough for typical multi-paragraph prompts without
// crushing the transcript above.
const maxPromptHeight = 8

type Prompt struct {
	ta    textarea.Model
	width int
	// boxOverhead is the column count consumed by the lipgloss box
	// border + padding (left + right). Used to derive the textarea's
	// inner width from the prompt's outer width.
	boxOverhead int
}

func NewPrompt() Prompt {
	ta := textarea.New()
	ta.Placeholder = "type a message..."
	ta.Prompt = "› "
	ta.ShowLineNumbers = false
	ta.CharLimit = 0 // no limit
	ta.MaxHeight = maxPromptHeight
	ta.SetHeight(1)
	// Strip the textarea's own decoration so our outer rounded box owns
	// every visible border. The textarea otherwise renders its own
	// per-row prompt + an optional border which would double up with
	// ours.
	ta.FocusedStyle.Base = lipgloss.NewStyle()
	ta.BlurredStyle.Base = lipgloss.NewStyle()
	// Drop the active-line tint — the box border itself is enough of a
	// visual focal cue and the tint clashes with custom themes on some
	// terminals.
	ta.FocusedStyle.CursorLine = lipgloss.NewStyle()
	ta.BlurredStyle.CursorLine = lipgloss.NewStyle()
	// ux-fixes round 3 — bind Alt+Enter (and Ctrl+J as the universal
	// fallback because Shift+Enter is terminal-dependent) for inserting
	// a real newline. App.go intercepts plain Enter and routes it to
	// submit BEFORE the textarea Update sees it, so the only way to
	// get a newline into the buffer is via these alternate keys.
	ta.KeyMap.InsertNewline = key.NewBinding(
		key.WithKeys("alt+enter", "ctrl+j"),
		key.WithHelp("alt+enter", "insert newline"),
	)
	ta.Focus()
	return Prompt{ta: ta, boxOverhead: 4}
}

// Update forwards events to the embedded textarea. After every update
// the textarea's height is reconciled with the visual line count of
// its current content so the box grows (or shrinks) to fit. App.go
// intercepts plain Enter before delegating here, so the textarea never
// sees Enter in normal operation — Alt+Enter / Ctrl+J still insert
// real newlines because app.go forwards them unchanged.
func (p Prompt) Update(msg tea.Msg) (Prompt, tea.Cmd) {
	var cmd tea.Cmd
	p.ta, cmd = p.ta.Update(msg)
	p.ta.SetHeight(p.computeHeight())
	return p, cmd
}

// SetWidth records the new outer width and reconfigures the textarea's
// inner width + height. App.go calls this on every WindowSizeMsg.
func (p *Prompt) SetWidth(w int) {
	p.width = w
	inner := w - p.boxOverhead
	if inner < 1 {
		inner = 1
	}
	p.ta.SetWidth(inner)
	p.ta.SetHeight(p.computeHeight())
}

// Value returns the current text buffer including any embedded
// newlines (Alt+Enter inserts).
func (p Prompt) Value() string {
	return p.ta.Value()
}

// Clear empties the buffer and collapses the textarea back to a single
// row. Called by app.go after a successful submit.
func (p *Prompt) Clear() {
	p.ta.Reset()
	p.ta.SetHeight(1)
}

// SetValue replaces the buffer verbatim and parks the cursor at the
// end. Used by slash-autocomplete on Tab-complete and by recall
// navigation. Recomputes height so the box matches the new content.
func (p *Prompt) SetValue(v string) {
	p.ta.SetValue(v)
	// Move cursor to the end. Bubble textarea exposes CursorEnd on the
	// last logical line; walk the lines to put the cursor on the final
	// one first.
	lines := strings.Split(v, "\n")
	for i := 0; i < len(lines)-1; i++ {
		p.ta.CursorDown()
	}
	p.ta.CursorEnd()
	p.ta.SetHeight(p.computeHeight())
}

// Height returns the textarea's current visible row count (1 to
// maxPromptHeight). App.go adds 2 for the top + bottom box border to
// get total prompt-area chrome and reserves that much space below the
// transcript.
func (p Prompt) Height() int {
	return p.computeHeight()
}

// View renders the textarea inside a rounded lipgloss box. The box's
// outer width is `p.width`; subtracting the 2 border columns gives the
// box.Width parameter lipgloss expects.
func (p Prompt) View() string {
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("#6c7086")). // Catppuccin overlay1 — visible but muted
		Padding(0, 1).
		Width(p.width - 2)
	return box.Render(p.ta.View())
}

// computeHeight returns the visual row count required to render the
// current content with soft-wrap at the textarea's effective wrap
// column. The textarea's wrap column = inner_width - prompt_width
// (the per-row "› " prefix). Empty lines count as 1 row each so the
// cursor on an otherwise-blank line still has a row to live on.
func (p Prompt) computeHeight() int {
	inner := p.width - p.boxOverhead
	if inner <= 0 {
		return 1
	}
	// textarea.Model.SetWidth subtracts the prompt's display width
	// from its internal wrap column. We use the same prompt the
	// textarea uses ("› " = 2 visible columns).
	wrap := inner - 2
	if wrap < 1 {
		wrap = 1
	}
	total := 0
	for _, line := range strings.Split(p.ta.Value(), "\n") {
		w := lipgloss.Width(line)
		if w == 0 {
			total++
			continue
		}
		total += (w + wrap - 1) / wrap
	}
	if total < 1 {
		total = 1
	}
	if total > maxPromptHeight {
		total = maxPromptHeight
	}
	return total
}
