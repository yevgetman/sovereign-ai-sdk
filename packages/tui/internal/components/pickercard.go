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

// pickerBadgeLiveColor is the success-green used for the "✓ live" badge
// on config items with a registered live-apply hook. Catppuccin "green"
// — sits visually distinct from pickerItemColor (orange) so the user
// can read "live vs reload" at a glance. 2026-05-24 config UX rebuild.
var pickerBadgeLiveColor = lipgloss.Color("#a6e3a1")

// Badge string constants — discriminated values on PickerItem.Badge.
// Server emits `"live"` or `"reload"`; any other value (including empty)
// renders no badge. Keep these in sync with the BadgeSchema enum on
// the TS side. 2026-05-24 config UX rebuild.
const (
	pickerBadgeLive   = "live"
	pickerBadgeReload = "reload"
)

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

// OnBack returns the dispatcher command to re-invoke on backspace
// (back-navigation). Empty string means no parent — the picker is
// at the root or is a non-hierarchical surface (/model, /resume,
// /export, /theme), and backspace should be a no-op.
//
// 2026-05-24 patch.
func (p *PickerCard) OnBack() string {
	if p.payload.OnBack == nil {
		return ""
	}
	return p.payload.OnBack.Command
}

// SetTheme swaps the theme used by subsequent View() calls.
func (p *PickerCard) SetTheme(t theme.Theme) {
	p.theme = t
}

// hasExtraColumns reports whether ANY item in the payload sets
// ValueColumn or Badge — the trigger for the wide-row layout used by
// /config submenus. When false, View() renders the M11.5 baseline
// (label + optional hint) so /model, /resume, /export, /theme stay
// byte-identical visually. 2026-05-24 config UX rebuild.
func (p PickerCard) hasExtraColumns() bool {
	for _, item := range p.payload.Items {
		if item.ValueColumn != "" || item.Badge != "" {
			return true
		}
	}
	return false
}

// labelColumnWidth returns the widest label across all items so the
// value column lines up uniformly across rows. Uses lipgloss.Width on
// the un-styled label string — ANSI escape codes haven't been wrapped
// yet at this point so the rune count is accurate. 2026-05-24 config
// UX rebuild.
func (p PickerCard) labelColumnWidth() int {
	w := 0
	for _, item := range p.payload.Items {
		if n := lipgloss.Width(item.Label); n > w {
			w = n
		}
	}
	return w
}

// renderBadge returns the styled badge text for an item, or empty when
// the badge value is unknown (or empty). Badge "live" renders as
// "✓ live" in success-green; "reload" renders as "⟳ next session" in
// the same pale-orange used for non-selected item labels (so the badge
// reads as a quiet "not yet applied" cue, not an error). Any other
// badge string renders nothing.
//
// The badge style is computed by the caller (foreground only, no bold)
// so the selected row's bold doesn't bleed into the badge — keeping the
// badge readable as a status pill on every row. 2026-05-24 config UX
// rebuild.
func (p PickerCard) renderBadge(badge string) string {
	switch badge {
	case pickerBadgeLive:
		return lipgloss.NewStyle().Foreground(pickerBadgeLiveColor).Render("✓ live")
	case pickerBadgeReload:
		return lipgloss.NewStyle().Foreground(pickerItemColor).Render("⟳ next session")
	default:
		return ""
	}
}

// View renders the picker card. `width` is the total width of the
// card including its border. When width < 6 the box is dropped and
// the inner body is returned bare — mirrors the autocomplete popup's
// narrow-terminal fallback so the card still degrades gracefully.
//
// 2026-05-24 (config UX rebuild) — when ANY item sets ValueColumn or
// Badge, View renders the "wide" layout: label is left-aligned in a
// label column padded to the widest label across all items; value
// column sits 3 spaces to the right; badge follows the value with one
// space of separation. When neither extra field is set on any item,
// View renders the M11.5 baseline (label + optional hint) — backwards
// compatible for /model, /resume, /export, /theme.
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
	useWideLayout := p.hasExtraColumns()
	labelColW := 0
	if useWideLayout {
		labelColW = p.labelColumnWidth()
	}
	const valueGap = 3 // spaces between label-column end and value-column start
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
		if useWideLayout {
			// Wide layout: pad to labelColW, then value column + badge.
			pad := labelColW - lipgloss.Width(item.Label)
			if pad < 0 {
				pad = 0
			}
			row += strings.Repeat(" ", pad+valueGap)
			if item.ValueColumn != "" {
				// Value column renders dim — it's a contextual readback,
				// not the primary actionable content (the label is).
				row += hintStyle.Render(item.ValueColumn)
			}
			if badge := p.renderBadge(item.Badge); badge != "" {
				if item.ValueColumn != "" {
					row += "  "
				}
				row += badge
			}
		} else {
			// Baseline layout (M11.5) — label + optional hint.
			if item.Hint != "" {
				row += "  " + hintStyle.Render(item.Hint)
			}
		}
		lines = append(lines, row)
	}

	// Footer — recessive grey-blue italic, separated by a blank line
	// from the items (M11.16 spacing convention).
	//
	// 2026-05-24 patch — surface the backspace hint when the payload
	// has an OnBack so users discover the back-navigation. Pickers
	// without a parent (root menu, /model, /resume, /export, /theme)
	// keep the M11.5 footer.
	footerStyle := lipgloss.NewStyle().Foreground(pickerFooterColor).Italic(true)
	footerText := "↑/↓ navigate · enter confirm · esc cancel"
	if p.payload.OnBack != nil {
		footerText = "↑/↓ navigate · enter confirm · backspace back · esc cancel"
	}
	footer := footerStyle.Render(footerText)
	body := strings.Join(lines, "\n") + "\n\n" + footer

	if width < 6 {
		return body
	}
	box := p.theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(body)
}
