package theme

import "github.com/charmbracelet/lipgloss"

// Sovereign returns the brand-aligned palette for the Sovereign AI harness.
// Cool slate background + cyan-blue primary; AI-tooling aesthetic. GitHub
// Dark inspired with a cooler primary. M9.5 spec §3.5 pins the hex codes.
func Sovereign() Theme {
	return Theme{
		Name:           "sovereign",
		Background:     lipgloss.Color("#0d1117"),
		Foreground:     lipgloss.Color("#e6edf3"),
		Dim:            lipgloss.Color("#7d8590"),
		Border:         lipgloss.Color("#30363d"),
		Primary:        lipgloss.Color("#58a6ff"),
		Success:        lipgloss.Color("#3fb950"),
		Warning:        lipgloss.Color("#d29922"),
		Error:          lipgloss.Color("#f85149"),
		Info:           lipgloss.Color("#6e7681"),
		CodeBackground: lipgloss.Color("#161b22"),
		DiffAdded:      lipgloss.Color("#3fb950"),
		DiffRemoved:    lipgloss.Color("#f85149"),
		DiffContext:    lipgloss.Color("#7d8590"),
	}
}
