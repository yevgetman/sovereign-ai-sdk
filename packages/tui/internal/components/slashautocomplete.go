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

// staticEntries is the compile-time list of slash commands shown in the
// autocomplete popup. /compact, /expand, /skills, /theme have dedicated
// client-side dispatch in app/app.go; everything else routes to the TS
// server via POST /sessions/:id/commands (M10.5). The list is hand-
// mirrored from the TS COMMAND_REGISTRY in src/commands/registry.ts —
// backlog #45 plans a GET /sessions/:id/commands discovery endpoint
// that would eliminate the drift hazard.
var staticEntries = []Entry{
	{Name: "/about", Description: "show version, provider, model, and bundle info"},
	{Name: "/clear", Description: "clear history by starting a fresh child session"},
	{Name: "/commit", Description: "ask the model to stage, write a message, and commit"},
	{Name: "/compact", Description: "summarize prior turns and start a child session"},
	{Name: "/config", Description: "view or change durable user-level config"},
	{Name: "/context-budget", Description: "audit context-window usage across system, tools, skills, bundle, memory"},
	{Name: "/continue", Description: "resume a turn paused by the tool-call checkin limit"},
	{Name: "/copy", Description: "copy the last assistant message to the clipboard"},
	{Name: "/cost", Description: "show token usage and estimated cost for this session"},
	{Name: "/expand", Description: "re-render the Nth-most-recent tool block expanded"},
	{Name: "/export", Description: "export the session transcript (md / jsonl / json)"},
	{Name: "/help", Description: "list available slash commands"},
	{Name: "/init", Description: "scan the project and write a CONTEXT.md briefing"},
	{Name: "/model", Description: "switch the active model — opens a picker or accepts a name"},
	{Name: "/permissions", Description: "show the active permission mode and any auto-allow rules"},
	{Name: "/quit", Description: "exit the session and print the summary"},
	{Name: "/resume", Description: "pick a recent session and print its resume command"},
	{Name: "/review", Description: "list, show, approve, reject, or revoke review proposals"},
	{Name: "/rollback", Description: "switch back to the parent session after /compact"},
	{Name: "/settings", Description: "open the interactive settings editor (TTY only)"},
	{Name: "/skills", Description: "list, install, uninstall, or reload skills"},
	{Name: "/stats", Description: "show the current session summary card mid-session"},
	{Name: "/tasks", Description: "list background sub-agent tasks; show or stop one"},
	{Name: "/theme", Description: "switch between light and dark themes"},
	{Name: "/tools", Description: "list the tools registered in the current session"},
}

// SlashAutocomplete is a popup overlay with fuzzy-matching against
// staticEntries / dynamic commands + skill cache. Mutates state via
// SetFilter; render via View.
//
// Backlog #45: `commands` is populated at boot by a GET
// /sessions/:id/commands fetch. When non-empty, it REPLACES the
// compile-time `staticEntries` as the source of slash-command names —
// production runs see the live TS COMMAND_REGISTRY; tests + pre-fetch
// race cases fall back to `staticEntries`.
type SlashAutocomplete struct {
	visible  bool
	filter   string
	selected int
	matches  []Entry
	theme    theme.Theme
	skills   []transport.Skill
	commands []transport.CommandDescriptor
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

// SetCommands replaces the cached slash-command list. Called from
// app.go's commandsFetchedMsg handler at boot. When non-empty, the
// dynamic list REPLACES `staticEntries` as the source of built-in
// command names; when empty, the compile-time list is used as the
// fallback. Backlog #45.
func (s *SlashAutocomplete) SetCommands(commands []transport.CommandDescriptor) {
	s.commands = commands
}

// entryList returns the slash-command entries to fuzzy-match against.
// Dynamic commands (post-#45 fetch) take precedence over staticEntries
// (the compile-time fallback). The "/" prefix is added here so callers
// don't need to prepend it.
func (s SlashAutocomplete) entryList() []Entry {
	if len(s.commands) > 0 {
		out := make([]Entry, 0, len(s.commands))
		for _, c := range s.commands {
			out = append(out, Entry{
				Name:        "/" + c.Name,
				Description: c.Description,
			})
		}
		return out
	}
	return staticEntries
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

// compute filters the entry list (dynamic commands or static fallback,
// plus skills) by the filter string. Fuzzy match: case-insensitive
// prefix on the part after `/`. Capped at 10 matches.
//
// Backlog #45: when s.commands is non-empty (post-fetch), it REPLACES
// staticEntries entirely. When empty (pre-fetch / tests with no
// server), staticEntries is the fallback source.
func (s SlashAutocomplete) compute() []Entry {
	q := strings.TrimPrefix(s.filter, "/")
	q = strings.ToLower(q)
	commandEntries := s.entryList()
	all := make([]Entry, 0, len(commandEntries)+len(s.skills))
	all = append(all, commandEntries...)
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
	// new users discover the autocomplete controls. Italic to match
	// the general "ambient guidance" style used in HintLine/notifications.
	// M11.16 — blank-line spacer between the match list and the hint
	// so the hint reads as a separate informational footer rather
	// than as another match row.
	// Post-M11.5 polish (uxissue2): Enter is the primary action — it
	// fills the selection AND submits in one keystroke. Tab still works
	// silently as the fill-only path for users typing args manually.
	// Esc dismisses the popup.
	hintStyle := lipgloss.NewStyle().Foreground(autocompleteHintColor).Italic(true)
	hint := hintStyle.Render("Press Enter to select · Esc to cancel")
	body := strings.Join(lines, "\n") + "\n\n" + hint
	if width < 6 {
		return body
	}
	box := s.theme.CardBorderStyle().Padding(0, 1).Width(width - 2)
	return box.Render(body)
}
