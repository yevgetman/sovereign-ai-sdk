// Package components — StatusLine: bottom anchored status row.
//
// M2: hardcoded fields (cwd, provider, model placeholders). M3 wires real
// state. M9 T10: themed; consumes status_update SSE events to drive a
// streaming spinner and a live cost field on the right side.

package components

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

type StatusLine struct {
	width     int
	Cwd       string
	Profile   string
	Provider  string
	Model     string
	Cost      float64
	CacheHit  float64
	Streaming bool
	TokensIn  int
	TokensOut int
	Theme     theme.Theme

	// TaskRouter — when non-empty, the profile column renders
	// "Task Router Active (<value>)" instead of the profile name.
	// Value is the preset id ('frugal-anthropic', 'my-setup', etc.)
	// or the literal string 'custom' when no preset matches. Empty
	// means task routing is off; profile column falls back to the
	// standard `s.Profile` display. 2026-05-24 patch.
	TaskRouter string

	// Effort — reasoning-depth level for the current session
	// (off|low|medium|high|max). Mirrors Model: set by the
	// /effort <level> side-effect (effortChanged) so the chrome
	// reflects the live runtime.effort. Empty until the user first
	// sets it — the left column omits the field entirely while empty
	// rather than showing a placeholder (unlike Model, effort isn't
	// seeded at boot). Slice D / T7.
	Effort string

	// PermissionMode — the active permission posture
	// (default|plan|acceptEdits|bypass). Set by the live
	// permissionModeChanged side-effect (2026-06-14 config live-apply
	// M6). Empty or "default" renders nothing (the implicit, expected
	// posture). A non-default mode renders a chip on the right edge;
	// 'bypass' renders a LOUD red BYPASS chip because it disables every
	// approval gate (safety reflection).
	PermissionMode string

	// M9 T10 — spinner frame index, advanced by Tick events from app.go.
	spinner int
}

// permissionModeBypass is the one mode that disables all approval gates;
// it gets the loud red chip. Other non-default modes get a quiet chip.
const permissionModeBypass = "bypass"

// spinnerFrames is the braille-spinner animation used during streaming.
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// NewStatusLine returns a status line with default placeholder values.
// Theme is constructor-injected per ADR M9-01.
//
// ux-fixes round 3: Provider and Model default to empty strings (not "?")
// so the splash card and any consumers that check truthiness behave
// correctly before the launcher seeds the real values via WithSessionInfo.
// Cwd retains "?" because app.go always overwrites it with os.Getwd().
func NewStatusLine(t theme.Theme) StatusLine {
	return StatusLine{
		Cwd:      "?",
		Profile:  "default",
		Provider: "",
		Model:    "",
		Theme:    t,
	}
}

func (s *StatusLine) SetWidth(w int) {
	s.width = w
}

// SetTheme swaps the active theme. Called from app.go's /theme handler.
func (s *StatusLine) SetTheme(t theme.Theme) {
	s.Theme = t
}

// AdvanceSpinner moves to the next frame. Called from app.go's spinner Tick.
func (s *StatusLine) AdvanceSpinner() {
	s.spinner = (s.spinner + 1) % len(spinnerFrames)
}

// SpinnerFrame returns the current frame character. Exposed for testing.
func (s StatusLine) SpinnerFrame() string {
	return spinnerFrames[s.spinner]
}

// permissionChip renders the permission-mode indicator, or "" when the
// mode is empty/"default" (the implicit posture — no chrome needed).
// 'bypass' renders a LOUD chip in the theme's error red (bold) because it
// disables every approval gate; any other non-default mode renders a
// quiet warning-colored chip. The chip text is uppercased so it reads as
// a status pill, not a value. 2026-06-14 config live-apply (M6).
func (s StatusLine) permissionChip() string {
	if s.PermissionMode == "" || s.PermissionMode == "default" {
		return ""
	}
	label := strings.ToUpper(s.PermissionMode)
	if s.PermissionMode == permissionModeBypass {
		return lipgloss.NewStyle().
			Foreground(s.Theme.Error).
			Bold(true).
			Render(style.S.Glyph.Warning + " " + label)
	}
	return lipgloss.NewStyle().
		Foreground(s.Theme.Warning).
		Render(label)
}

func (s StatusLine) View() string {
	// M11.5 — drop the explicit background fill. On terminals where
	// the configured theme.Background hex doesn't match the actual
	// terminal background the filled row reads as a distracting
	// light strip. Letting the terminal background show through keeps
	// the status line subtle and consistent regardless of how the
	// terminal maps the theme's base color. The left half uses dim
	// foreground (not the theme's full Foreground) so the path /
	// profile / model read as ambient metadata, not primary content.
	dimFg := lipgloss.NewStyle().Foreground(s.Theme.Dim)

	// 2026-05-24 patch — when task routing is active, replace the
	// profile column with "Task Router Active (<preset>)" so users
	// see at a glance that routing is on AND which preset's in
	// effect. Empty TaskRouter falls back to the standard profile
	// display.
	profileColumn := s.Profile
	if s.TaskRouter != "" {
		profileColumn = fmt.Sprintf("Task Router Active (%s)", s.TaskRouter)
	}

	sep := style.S.StatusLine.FieldSeparator
	leftText := fmt.Sprintf("%s"+sep+"%s"+sep+"%s",
		s.Cwd,
		profileColumn,
		s.Model,
	)
	// Append the reasoning-depth field only once it's been set, so the
	// status line stays unchanged until the user runs /effort (effort
	// isn't seeded at boot like Model). Uses the same field separator
	// token — no hardcoded layout. Slice D / T7.
	if s.Effort != "" {
		leftText += sep + "effort:" + s.Effort
	}
	left := dimFg.Render(leftText)

	right := dimFg.Render(fmt.Sprintf("$%.4f"+sep+"cache %.0f%%", s.Cost, s.CacheHit*100))
	// Permission-mode chip sits at the leading edge of the right cluster
	// (a loud BYPASS chip is impossible to miss there). Rendered with its
	// own (error/warning) color so it stands out against the dim metadata.
	if chip := s.permissionChip(); chip != "" {
		right = chip + sep + right
	}
	if s.Streaming {
		spinStyle := lipgloss.NewStyle().Foreground(s.Theme.Primary).Bold(true)
		spin := spinStyle.Render(spinnerFrames[s.spinner])
		right = spin + sep + right
	}

	// Lay out left + right with padding between to fill width. The
	// padding row uses no styling so the terminal background fills
	// the gap naturally.
	padding := s.width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if padding < 1 {
		padding = 1
	}
	gap := lipgloss.NewStyle().Width(padding).Render(" ")
	edge := style.S.StatusLine.EdgeMargin
	return edge + left + gap + right + edge
}
