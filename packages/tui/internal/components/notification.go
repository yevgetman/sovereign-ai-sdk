// Package components — Notification: bordered notice box below the splash.
//
// M11.3 — surfaces contextual advisories (e.g., "running in $HOME,
// recommend a project-specific directory"; "no bundle detected") with
// a yellow-tinted rounded border so the user sees them as guidance
// rather than as errors. Mirrors the Qwen Code reference layout where
// a notification bar sits between the splash and the first user input.

package components

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// Notification renders a single advisory line wrapped in a rounded
// border. Multi-line messages get wrapped at the requested content
// width. Returns an empty string when message is empty so callers
// can unconditionally include it without padding noise.
//
// The border picks up theme.Warning for the soft yellow accent — the
// notification is informational guidance, not an error, so the warning
// color reads as "noticeable but not alarming."
//
// M11.10 — body text renders WITHOUT a foreground color so it inherits
// the terminal default foreground (same path as user-input rendering).
// Explicit theme.Foreground rendered dim on terminals with custom
// palettes; terminal default is reliably bright.
func Notification(message string, t theme.Theme, width int) string {
	if message == "" {
		return ""
	}
	if width <= 0 {
		width = 80
	}
	// Reserve 4 columns for the border characters + padding (two on
	// each side) so the content width matches the final visual width.
	contentWidth := width - 4
	if contentWidth < 10 {
		contentWidth = 10
	}
	// No Foreground on the body — terminal default renders it bright.
	body := lipgloss.NewStyle().
		Width(contentWidth).
		Render(message)
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(t.Warning).
		Padding(0, 1).
		Render(body)
	return box
}

// HintLine renders a small dim "? for shortcuts" style hint, padded
// with the same gutter the prompt uses so the hint aligns visually.
// Empty hints return "" so the caller can render unconditionally.
func HintLine(text string, t theme.Theme) string {
	if text == "" {
		return ""
	}
	return lipgloss.NewStyle().
		Foreground(t.Dim).
		Italic(true).
		Render(text)
}

// BootNotices inspects the boot context and returns the list of
// notification messages that should render below the splash. Empty
// slice means no notices apply. Decoupled from Notification rendering
// so callers can choose order, joining, or skip entirely. M11.3.
func BootNotices(cwd, home string, bundlePath string) []string {
	var notices []string
	if cwd != "" && home != "" && cwd == home {
		notices = append(notices,
			"You are running Sovereign AI in your home directory. It is recommended to run in a project-specific directory.")
	}
	if bundlePath == "" {
		notices = append(notices,
			"No bundle detected — add an index.yaml at your project root, run `sov init`, or set HARNESS_BUNDLE.")
	}
	return notices
}

// JoinNotices renders each notice via Notification and joins with a
// single blank line between them. Returns "" when notices is empty.
func JoinNotices(notices []string, t theme.Theme, width int) string {
	if len(notices) == 0 {
		return ""
	}
	rendered := make([]string, 0, len(notices))
	for _, n := range notices {
		r := Notification(n, t, width)
		if r != "" {
			rendered = append(rendered, r)
		}
	}
	return strings.Join(rendered, "\n")
}
