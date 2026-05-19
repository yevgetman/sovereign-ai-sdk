// Package components — PickerCard: inline scroll-flow card rendered in
// response to a `pickerOpen` dispatcher side-effect. M11.5 T4.
//
// Architecture (ADR M11.5-01): picker commands (`/model`, `/resume`,
// `/export`) invoked with no args emit a `pickerOpen` side-effect on
// the dispatcher response instead of running an in-process raw-mode
// pick() that would fight Bubble Tea's render loop. The TUI receives
// the payload, instantiates a PickerCard, and locks input until the
// user confirms (Enter) or cancels (Esc).
//
// Visual convention mirrors `slashautocomplete.go`:
//   - non-selected rows render in pale-orange (#fab387) without bold,
//   - the selected row drops the orange color and renders bold so the
//     terminal default foreground (typically bright white) makes it
//     pop against the orange neighbours,
//   - the footer hint uses the same grey-blue (#7a8eb8) italic style
//     as the autocomplete popup, recessive ambient guidance.
//
// The box wraps in `theme.CardBorderStyle()` for consistency with the
// autocomplete popup and other inline cards.

package components

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// pickerItemColor is the pale-orange foreground used for non-selected
// item rows. Catppuccin "peach" — shared by slashautocomplete.go for
// visual consistency across inline-card surfaces (M11.14).
var pickerItemColor = lipgloss.Color("#fab387")

// pickerFooterColor is the recessive grey-blue used for the navigation
// hint at the bottom of the card. Same shade as `autocompleteHintColor`
// in slashautocomplete.go — read as ambient guidance, not competing
// with the item rows above (M11.15).
var pickerFooterColor = lipgloss.Color("#7a8eb8")

// PickerCard is a Bubble Tea component that renders an inline picker.
// Construct with NewPickerCard; navigate with MoveUp/MoveDown; read the
// chosen value via Selected and the dispatch command via Command. The
// component is value-mutated (pointer receiver methods) to match the
// shape used by SlashAutocomplete elsewhere in this package.
type PickerCard struct {
	payload  transport.PickerOpenPayload
	selected int
	theme    theme.Theme
}

// NewPickerCard returns a PickerCard initialized to payload.Initial,
// clamped to [0, len(items)-1]. Empty-items payloads are accepted —
// View() still renders a card with the title + footer, and Selected()
// reports (_, false).
func NewPickerCard(payload transport.PickerOpenPayload, t theme.Theme) PickerCard {
	initial := payload.Initial
	if initial < 0 {
		initial = 0
	}
	if n := len(payload.Items); n > 0 && initial >= n {
		initial = n - 1
	}
	if len(payload.Items) == 0 {
		initial = 0
	}
	return PickerCard{
		payload:  payload,
		selected: initial,
		theme:    t,
	}
}

// MoveDown advances the selected index forward, clamped to the last
// item. No-op on empty payloads.
func (p *PickerCard) MoveDown() {
	if p.selected+1 < len(p.payload.Items) {
		p.selected++
	}
}

// MoveUp moves the selected index backward, clamped to 0. No-op on
// empty payloads.
func (p *PickerCard) MoveUp() {
	if p.selected > 0 {
		p.selected--
	}
}

// Selected returns the currently-highlighted item's Value and an ok
// flag. ok is false when the picker has no items.
func (p *PickerCard) Selected() (string, bool) {
	if len(p.payload.Items) == 0 {
		return "", false
	}
	if p.selected < 0 || p.selected >= len(p.payload.Items) {
		return "", false
	}
	return p.payload.Items[p.selected].Value, true
}

// Command returns the dispatcher command that should be re-invoked
// with the Selected() value on Enter.
func (p *PickerCard) Command() string {
	return p.payload.OnSelect.Command
}

// SetTheme swaps the theme used by subsequent View() calls.
func (p *PickerCard) SetTheme(t theme.Theme) {
	p.theme = t
}

// View renders the picker card. `width` is the total width of the
// card including its border. When width < 6 the box is dropped and
// the inner body is returned bare — mirrors the autocomplete popup's
// narrow-terminal fallback so the card still degrades gracefully.
func (p PickerCard) View(width int) string {
	var lines []string

	// Title — bold, no Foreground so the terminal default fg renders
	// bright. Same approach as the selected-row pattern in
	// slashautocomplete.go (M11.14).
	titleStyle := lipgloss.NewStyle().Bold(true)
	lines = append(lines, titleStyle.Render(p.payload.Title))

	// Subtitle — dim italic, only when present.
	if p.payload.Subtitle != "" {
		subtitleStyle := lipgloss.NewStyle().Foreground(p.theme.Dim).Italic(true)
		lines = append(lines, subtitleStyle.Render(p.payload.Subtitle))
	}

	// Items — pale orange for unselected, bold + default-fg for
	// selected. Hint sits dim next to the label.
	hintStyle := lipgloss.NewStyle().Foreground(p.theme.Dim)
	for i, item := range p.payload.Items {
		var prefix string
		var labelStyle lipgloss.Style
		if i == p.selected {
			prefix = "› "
			labelStyle = lipgloss.NewStyle().Bold(true)
		} else {
			prefix = "  "
			labelStyle = lipgloss.NewStyle().Foreground(pickerItemColor)
		}
		row := prefix + labelStyle.Render(item.Label)
		if item.Hint != "" {
			row += "  " + hintStyle.Render(item.Hint)
		}
		lines = append(lines, row)
	}

	// Footer — recessive grey-blue italic, separated by a blank line
	// from the items (M11.16 spacing convention).
	footerStyle := lipgloss.NewStyle().Foreground(pickerFooterColor).Italic(true)
	footer := footerStyle.Render("↑/↓ navigate · enter confirm · esc cancel")
	body := strings.Join(lines, "\n") + "\n\n" + footer

	if width < 6 {
		return body
	}
	box := p.theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(body)
}
