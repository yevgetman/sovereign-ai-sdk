// Package components — SlashAutocomplete: popup overlay shown when the
// prompt input starts with `/`. Fuzzy-matches against static slash commands
// + the cached skills (M8 T6). M9 T8.
//
// Architecture (ADR M9-05): cache fetched at boot via the M8 T6 skill
// hydration; static command list is compile-time. Invalidation deferred —
// the popup's fuzzy matcher tolerates a slightly stale skill cache.
package components

import (
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// Entry is one item displayed in the autocomplete popup.
type Entry struct {
	Name        string // includes leading "/"
	Description string
}

// staticEntries is the compile-time list of TUI-side slash commands. The
// dispatch handlers for each live in app/app.go's ENTER key handler.
var staticEntries = []Entry{
	{Name: "/compact", Description: "summarize prior turns and start a child session"},
	{Name: "/expand", Description: "re-render the Nth-most-recent tool block expanded"},
	{Name: "/theme", Description: "switch between light and dark themes"},
}

// SlashAutocomplete is a popup overlay with fuzzy-matching against staticEntries
// + skill cache. Mutates state via SetFilter; render via View.
type SlashAutocomplete struct {
	visible  bool
	filter   string
	selected int
	matches  []Entry
	theme    theme.Theme
	skills   []transport.Skill
}

// NewSlashAutocomplete returns a hidden, empty popup. Set the skill cache via
// SetSkills once the M8 T6 hydration completes.
func NewSlashAutocomplete(t theme.Theme) SlashAutocomplete {
	return SlashAutocomplete{theme: t}
}

// SetSkills replaces the cached skill list. Called from app.go's
// skillsFetchedMsg handler.
func (s *SlashAutocomplete) SetSkills(skills []transport.Skill) {
	s.skills = skills
}

// SetTheme swaps the theme used to render the popup.
func (s *SlashAutocomplete) SetTheme(t theme.Theme) {
	s.theme = t
}

// Visible reports whether the popup should be rendered.
func (s SlashAutocomplete) Visible() bool { return s.visible }

// SetFilter updates the popup state from the current prompt text. Caller
// passes the raw prompt content; the popup detects whether it starts with
// `/`, updates filter + matches, and toggles visibility. Selected index
// clamps to len(matches)-1.
func (s *SlashAutocomplete) SetFilter(promptText string) {
	if !strings.HasPrefix(promptText, "/") {
		s.visible = false
		s.filter = ""
		s.matches = nil
		s.selected = 0
		return
	}
	s.visible = true
	s.filter = promptText
	s.matches = s.compute()
	if s.selected >= len(s.matches) {
		s.selected = 0
	}
}

// MoveDown cycles forward through matches with bounds clamp.
func (s *SlashAutocomplete) MoveDown() {
	if s.selected+1 < len(s.matches) {
		s.selected++
	}
}

// MoveUp cycles backward through matches with bounds clamp.
func (s *SlashAutocomplete) MoveUp() {
	if s.selected > 0 {
		s.selected--
	}
}

// Completion returns the highlighted entry's Name (with leading `/`) that
// the prompt should be replaced with on Tab. Empty when no matches.
func (s SlashAutocomplete) Completion() string {
	if len(s.matches) == 0 || s.selected < 0 || s.selected >= len(s.matches) {
		return ""
	}
	return s.matches[s.selected].Name
}

// Dismiss hides the popup without affecting the prompt text.
func (s *SlashAutocomplete) Dismiss() {
	s.visible = false
}

// compute filters the entry list (static + skills) by the filter string.
// Fuzzy match: case-insensitive prefix on the part after `/`.
// Capped at 10 matches.
func (s SlashAutocomplete) compute() []Entry {
	q := strings.TrimPrefix(s.filter, "/")
	q = strings.ToLower(q)
	all := make([]Entry, 0, len(staticEntries)+len(s.skills))
	all = append(all, staticEntries...)
	for _, sk := range s.skills {
		all = append(all, Entry{
			Name:        "/" + sk.Name,
			Description: sk.Description,
		})
	}
	var matches []Entry
	for _, e := range all {
		name := strings.TrimPrefix(e.Name, "/")
		if q == "" || strings.HasPrefix(strings.ToLower(name), q) {
			matches = append(matches, e)
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return matches[i].Name < matches[j].Name
	})
	if len(matches) > 10 {
		matches = matches[:10]
	}
	return matches
}

// View renders the popup above the prompt row. width is the popup's width.
// Returns empty when hidden or empty matches list.
func (s SlashAutocomplete) View(width int) string {
	if !s.visible || len(s.matches) == 0 {
		return ""
	}
	var lines []string
	for i, m := range s.matches {
		nameStyle := lipgloss.NewStyle().Foreground(s.theme.Primary).Bold(true)
		descStyle := lipgloss.NewStyle().Foreground(s.theme.Dim)
		if i == s.selected {
			nameStyle = nameStyle.Background(s.theme.Border)
			descStyle = descStyle.Background(s.theme.Border)
		}
		line := nameStyle.Render(m.Name) + "  " + descStyle.Render(m.Description)
		lines = append(lines, line)
	}
	body := strings.Join(lines, "\n")
	if width < 6 {
		return body
	}
	box := s.theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(body)
}
