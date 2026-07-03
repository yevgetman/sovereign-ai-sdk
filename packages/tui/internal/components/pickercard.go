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
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

// Badge string constants — discriminated values on PickerItem.Badge.
// Server emits one of the four apply-scope badge tokens; any other value
// (including empty) renders no badge. Keep these in sync with the
// InputOpenConfigSchema / PickerOpenItemSchema badge enums on the TS side
// (src/config/applyScope.ts ScopeBadge). 2026-05-24 config UX rebuild;
// extended to 4 states 2026-06-14 config live-apply.
//
//   live    — applied to this session (green ✓)
//   reload  — applied this session via a between-turns reload (green ✓;
//             treated as live/applied — same green affordance)
//   other   — saved; applies to a separate gateway/serve process (amber ⤴)
//   restart — saved; needs restarting this process (amber ⟳)
const (
	pickerBadgeLive    = "live"
	pickerBadgeReload  = "reload"
	pickerBadgeOther   = "other"
	pickerBadgeRestart = "restart"
)

// Badge glyphs — the leading symbol for each badge state.
const (
	pickerBadgeGlyphApplied = "✓"
	pickerBadgeGlyphOther   = "⤴"
	pickerBadgeGlyphRestart = "⟳"
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

// OnSave returns the dispatcher command to invoke on the `S` key
// (commit & exit for /config draft pickers). Empty string when the
// picker doesn't wire this affordance. 2026-05-24 patch.
func (p *PickerCard) OnSave() string {
	if p.payload.OnSave == nil {
		return ""
	}
	return p.payload.OnSave.Command
}

// OnCancel returns the dispatcher command to invoke on `Esc` for
// pickers that want explicit cancel-and-exit semantics (the /config
// draft pickers, which discard pending changes). Empty string when
// absent — Esc falls back to the existing back-nav-or-close path.
// 2026-05-24 patch.
func (p *PickerCard) OnCancel() string {
	if p.payload.OnCancel == nil {
		return ""
	}
	return p.payload.OnCancel.Command
}

// SetTheme swaps the theme used by subsequent View() calls.
func (p *PickerCard) SetTheme(t theme.Theme) {
	p.theme = t
}

// pickerFooterText composes the footer hint line based on which
// optional key affordances the payload wires. Mix-and-match: a /config
// root picker has S/onCancel but no OnBack; a /config sub-picker has
// all three; /model has none. 2026-05-24 patch.
func pickerFooterText(hasBack, hasSave, hasCancel bool) string {
	parts := []string{"↑/↓ navigate", "enter confirm"}
	if hasBack {
		parts = append(parts, "backspace back")
	}
	if hasSave {
		parts = append(parts, "S save & exit")
	}
	if hasCancel {
		parts = append(parts, "esc cancel & exit")
	} else {
		parts = append(parts, "esc cancel")
	}
	return strings.Join(parts, " · ")
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

// badgeColorGlyphLabel maps a 4-state apply-scope badge token to its
// color (a brand hex), glyph, and label. The two green states ('live',
// 'reload') read as "applied to this session"; the two amber states
// ('other', 'restart') read as "saved, not applied here" with a reason.
// Returns ok=false for an unknown/empty token (caller renders nothing).
//
// Shared by the picker rows AND the InputCard so free-text fields show
// the same affordance. 2026-06-14 config live-apply (M6).
func badgeColorGlyphLabel(badge string) (color, glyph, label string, ok bool) {
	switch badge {
	case pickerBadgeLive:
		return style.S.Brand.PickerBadgeColor, pickerBadgeGlyphApplied, "live", true
	case pickerBadgeReload:
		// A bounded between-turns reload still applies THIS session — same
		// green "applied" affordance as 'live' (per the apply-scope spec).
		return style.S.Brand.PickerBadgeColor, pickerBadgeGlyphApplied, "applied", true
	case pickerBadgeOther:
		return style.S.Brand.PickerItemColor, pickerBadgeGlyphOther, "other process", true
	case pickerBadgeRestart:
		return style.S.Brand.PickerItemColor, pickerBadgeGlyphRestart, "restart", true
	default:
		return "", "", "", false
	}
}

// renderBadgeText returns the styled badge pill (glyph + label) for a
// 4-state apply-scope token, or "" when the token is unknown/empty.
// Foreground-only (no bold) so a caller's bold (e.g. a selected picker
// row) doesn't bleed into the pill — it stays readable as a status chip.
// 2026-06-14 config live-apply (M6).
func renderBadgeText(badge string) string {
	color, glyph, label, ok := badgeColorGlyphLabel(badge)
	if !ok {
		return ""
	}
	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(color)).
		Render(glyph + " " + label)
}

// renderBadge returns the styled badge text for a picker row, or empty
// when the badge value is unknown (or empty). Delegates to the shared
// renderBadgeText so the picker and InputCard agree on color+glyph+label
// for each scope. 2026-05-24 config UX rebuild; 4-state 2026-06-14.
func (p PickerCard) renderBadge(badge string) string {
	return renderBadgeText(badge)
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
	for i, item := range p.payload.Items {
		var prefix string
		var labelStyle lipgloss.Style
		if i == p.selected {
			prefix = style.S.Picker.SelectedPrefix
			labelStyle = lipgloss.NewStyle().Bold(true)
		} else {
			prefix = style.S.Picker.UnselectedPrefix
			labelStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(style.S.Brand.PickerItemColor))
		}
		row := prefix + labelStyle.Render(item.Label)
		if useWideLayout {
			// Wide layout: pad to labelColW, then value column + badge.
			pad := labelColW - lipgloss.Width(item.Label)
			if pad < 0 {
				pad = 0
			}
			row += strings.Repeat(" ", pad+style.S.Picker.ValueGap)
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
	// 2026-05-24 patch — surface keys conditionally:
	//   - backspace hint when OnBack is present
	//   - S / cancel-exit hints when OnSave / OnCancel are present
	//     (used by the /config draft-edit pickers)
	// Pickers without these keep the M11.5 baseline footer.
	footerStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(style.S.Brand.PickerHintColor)).Italic(true)
	footerText := pickerFooterText(p.payload.OnBack != nil, p.payload.OnSave != nil, p.payload.OnCancel != nil)
	footer := footerStyle.Render(footerText)
	body := strings.Join(lines, "\n") + "\n\n" + footer

	if width < 6 {
		return body
	}
	box := p.theme.CardBorderStyle().Padding(style.S.Card.PaddingV, style.S.Card.PaddingH).Width(width - style.S.Card.BorderOverhead)
	return box.Render(body)
}
