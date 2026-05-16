package render

import (
	"github.com/charmbracelet/glamour"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// Markdown renders Github-flavored markdown via glamour. Falls back to Plain
// on any glamour error so the TUI never crashes on garbage input from the
// model. Width is the wrap column (glamour's WordWrap).
func Markdown(text string, t theme.Theme, width int) string {
	if text == "" {
		return ""
	}
	if width <= 0 {
		return text
	}
	style := glamourStyleForTheme(t)
	r, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle(style),
		glamour.WithWordWrap(width),
	)
	if err != nil {
		return Plain(text, t, width)
	}
	out, err := r.Render(text)
	if err != nil {
		return Plain(text, t, width)
	}
	return out
}

// glamourStyleForTheme picks a built-in glamour style closest to our theme.
// glamour's bundled styles handle the syntax highlight + heading colors;
// matching by theme name keeps M9 small. M9.5 may swap to custom glamour
// styles built from theme.Theme tokens.
func glamourStyleForTheme(t theme.Theme) string {
	if t.Name == "light" {
		return "light"
	}
	return "dark"
}
