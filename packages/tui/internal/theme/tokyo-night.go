package theme

import "github.com/charmbracelet/lipgloss"

// TokyoNight returns the Tokyo Night Storm palette. Widely recognized in
// developer communities; free-to-use. M9.5 spec §3.6 pins the hex codes.
func TokyoNight() Theme {
	return Theme{
		Name:           "tokyo-night",
		Background:     lipgloss.Color("#1a1b26"),
		Foreground:     lipgloss.Color("#c0caf5"),
		Dim:            lipgloss.Color("#565f89"),
		Border:         lipgloss.Color("#2f334d"),
		Primary:        lipgloss.Color("#7aa2f7"),
		Success:        lipgloss.Color("#9ece6a"),
		Warning:        lipgloss.Color("#e0af68"),
		Error:          lipgloss.Color("#f7768e"),
		Info:           lipgloss.Color("#565f89"),
		CodeBackground: lipgloss.Color("#16161e"),
		DiffAdded:      lipgloss.Color("#9ece6a"),
		DiffRemoved:    lipgloss.Color("#f7768e"),
		DiffContext:    lipgloss.Color("#565f89"),
	}
}
