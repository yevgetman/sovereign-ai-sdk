package theme

import "github.com/charmbracelet/lipgloss"

// Light returns the Catppuccin Latte palette. ADR M9-11.
func Light() Theme {
	return Theme{
		Name:           "light",
		Background:     lipgloss.Color("#eff1f5"), // base
		Foreground:     lipgloss.Color("#4c4f69"), // text
		Dim:            lipgloss.Color("#9ca0b0"), // overlay1
		Border:         lipgloss.Color("#bcc0cc"), // surface1
		Primary:        lipgloss.Color("#1e66f5"), // blue
		Success:        lipgloss.Color("#40a02b"), // green
		Warning:        lipgloss.Color("#df8e1d"), // yellow
		Error:          lipgloss.Color("#d20f39"), // red
		Info:           lipgloss.Color("#8c8fa1"), // overlay2
		CodeBackground: lipgloss.Color("#e6e9ef"), // mantle
		DiffAdded:      lipgloss.Color("#40a02b"), // green
		DiffRemoved:    lipgloss.Color("#d20f39"), // red
		DiffContext:    lipgloss.Color("#9ca0b0"), // overlay1
	}
}
