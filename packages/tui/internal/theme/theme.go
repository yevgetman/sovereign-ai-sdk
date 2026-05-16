// Package theme provides constructor-injected color + style palettes for the
// Phase 16.1 TUI. v1 ships two built-in themes (light + dark); a TOML loader
// for user themes is deferred to M9.5 (ADR M9-03).
package theme

import "github.com/charmbracelet/lipgloss"

// Theme is a frozen palette + lipgloss style helpers. Pass by value to
// components via their New(...) constructors. Swap by re-constructing a new
// Theme and dispatching a themeChanged tea.Msg in the app layer.
type Theme struct {
	Name string

	// Surface colors
	Background lipgloss.Color
	Foreground lipgloss.Color
	Dim        lipgloss.Color // muted text (timestamps, separators)
	Border     lipgloss.Color // card borders

	// Semantic accent colors
	Primary lipgloss.Color // user marker, prompt cursor
	Success lipgloss.Color // tool success header, "ok" marker
	Warning lipgloss.Color // permission modal border, stall badge
	Error   lipgloss.Color // turn_error, denied permission
	Info    lipgloss.Color // dim italic system messages

	// Code/diff specifics
	CodeBackground lipgloss.Color
	DiffAdded      lipgloss.Color
	DiffRemoved    lipgloss.Color
	DiffContext    lipgloss.Color
}

// HeaderStyle returns the bold-primary header used at the top of tool cards.
func (t Theme) HeaderStyle() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.Primary).Bold(true)
}

// DimStyle returns the italic-dim style used for system messages
// (thinking placeholders, "stream closed", etc).
func (t Theme) DimStyle() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.Dim).Italic(true)
}

// ErrorStyle returns the red-bold style for turn errors.
func (t Theme) ErrorStyle() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.Error).Bold(true)
}

// CardBorderStyle returns the rounded-border style for cards.
func (t Theme) CardBorderStyle() lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(t.Border)
}

// StatusBarStyle returns the muted bg/fg used by the status line.
func (t Theme) StatusBarStyle() lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(t.Foreground).
		Background(t.Background)
}

// Resolve returns the theme by name. Unknown names return Dark() with the
// returned bool false; callers may log + fall back without erroring.
func Resolve(name string) (Theme, bool) {
	switch name {
	case "light":
		return Light(), true
	case "dark":
		return Dark(), true
	default:
		return Dark(), false
	}
}
