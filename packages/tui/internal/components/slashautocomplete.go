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

// SelectAt sets the selected index to idx and returns the corresponding
// completion string. Used by mouse-click region routing (M9.6 T1).
// Returns ("", false) for out-of-range indices.
func (s *SlashAutocomplete) SelectAt(idx int) (string, bool) {
	if idx < 0 || idx >= len(s.matches) {
		return "", false
	}
	s.selected = idx
	return s.matches[idx].Name, true
}

// PopupHeight returns the visible vertical height of the popup
// (entries + blank spacer + hint line + top/bottom border =
// entries+4). Returns 0 when hidden or empty. Used by mouse-click
// region routing in app.go (M9.6 T1) to map screen-Y to entry idx.
// M11.15 bumped by 1 for the Tab-autocomplete hint; M11.16 bumped
// by 1 more for the spacer between matches and hint.
func (s SlashAutocomplete) PopupHeight() int {
	if !s.visible || len(s.matches) == 0 {
		return 0
	}
	return len(s.matches) + 4
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

// slashCommandColor is the pale-orange foreground for slash command
// names in the autocomplete popup. Catppuccin "peach" — readable on
// dark and light terminals, distinct from inline-code's sky-blue and
// from theme.Primary's blue. M11.14: replaced theme.Primary (rendered
// too dark on user palettes; same family of palette-mapping issues
// documented in docs/conventions/tui-color-rendering.md, but for
// accent colors that need a specific shade).
var slashCommandColor = lipgloss.Color("#fab387")

// autocompleteHintColor is a subtle grey-blue for the "press Tab to
// autocomplete" hint at the bottom of the popup. Picked specifically
// to read as ambient guidance — visible enough that users notice it,
// recessive enough that it doesn't compete with the command names
// above it. M11.15.
var autocompleteHintColor = lipgloss.Color("#7a8eb8")

// View renders the popup above the prompt row. width is the popup's width.
// Returns empty when hidden or empty matches list.
//
// M11.14 — non-selected rows render in pale orange (slashCommandColor)
// without bold. Selected row drops the orange color and renders bold
// with NO foreground so the terminal default fg (typically bright
// white) shows through. The previous Background-highlight design made
// the selected text invisible on terminals where palette mapping
// inverts dark hexes. Bold + bright-default contrast against the
// orange neighbours gives a clear selection signal that survives
// every palette.
func (s SlashAutocomplete) View(width int) string {
	if !s.visible || len(s.matches) == 0 {
		return ""
	}
	var lines []string
	for i, m := range s.matches {
		var nameStyle lipgloss.Style
		descStyle := lipgloss.NewStyle().Foreground(s.theme.Dim)
		if i == s.selected {
			// Selected: bold, no Foreground — terminal default fg
			// (typically bright white) makes it pop against the
			// pale-orange neighbour rows.
			nameStyle = lipgloss.NewStyle().Bold(true)
		} else {
			// Non-selected: pale orange, regular weight.
			nameStyle = lipgloss.NewStyle().Foreground(slashCommandColor)
		}
		line := nameStyle.Render(m.Name) + "  " + descStyle.Render(m.Description)
		lines = append(lines, line)
	}
	// M11.15 — subtle grey-blue hint at the bottom of the popup so
	// new users discover Tab autocompletion. Italic to match the
	// general "ambient guidance" style used in HintLine/notifications.
	// M11.16 — blank-line spacer between the match list and the hint
	// so the hint reads as a separate informational footer rather
	// than as another match row.
	hintStyle := lipgloss.NewStyle().Foreground(autocompleteHintColor).Italic(true)
	hint := hintStyle.Render("Press Tab to autocomplete")
	body := strings.Join(lines, "\n") + "\n\n" + hint
	if width < 6 {
		return body
	}
	box := s.theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(body)
}
