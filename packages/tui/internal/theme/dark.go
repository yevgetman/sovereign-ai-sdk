package theme

import "github.com/charmbracelet/lipgloss"

// Dark returns the Catppuccin Mocha palette — the default theme.
//
// Palette source: https://github.com/catppuccin/catppuccin — free-to-use,
// AA-contrast tested. ADR M9-11.
func Dark() Theme {
	return Theme{
		Name:           "dark",
		Background:     lipgloss.Color("#1e1e2e"), // base
		Foreground:     lipgloss.Color("#cdd6f4"), // text
		Dim:            lipgloss.Color("#6c7086"), // overlay1
		Border:         lipgloss.Color("#45475a"), // surface1
		Primary:        lipgloss.Color("#89b4fa"), // blue
		Success:        lipgloss.Color("#a6e3a1"), // green
		Warning:        lipgloss.Color("#f9e2af"), // yellow
		Error:          lipgloss.Color("#f38ba8"), // red
		Info:           lipgloss.Color("#7f849c"), // overlay2
		CodeBackground: lipgloss.Color("#181825"), // mantle
		DiffAdded:      lipgloss.Color("#a6e3a1"), // green
		DiffRemoved:    lipgloss.Color("#f38ba8"), // red
		DiffContext:    lipgloss.Color("#6c7086"), // overlay1
	}
}
