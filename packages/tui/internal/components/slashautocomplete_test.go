package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

func TestSlashAutocompleteHiddenByDefault(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	if s.Visible() {
		t.Error("autocomplete should be hidden when no filter set")
	}
}

func TestSlashAutocompleteVisibleOnSlashInput(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	if !s.Visible() {
		t.Error("autocomplete should be visible when input starts with /")
	}
}

func TestSlashAutocompleteHiddenOnNonSlashInput(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	s.SetFilter("hello")
	if s.Visible() {
		t.Error("autocomplete should hide when input no longer starts with /")
	}
}

func TestSlashAutocompleteFiltersByPrefix(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	// /comp disambiguates from /commit (added when staticEntries
	// grew to cover every TS-registered command — backlog #45).
	s.SetFilter("/comp")
	completion := s.Completion()
	if completion != "/compact" {
		t.Errorf("filter /comp: got %q want /compact", completion)
	}
}

func TestSlashAutocompleteIncludesCachedSkills(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetSkills([]transport.Skill{
		{Name: "summarize", Description: "summarize the conversation"},
	})
	s.SetFilter("/sum")
	if s.Completion() != "/summarize" {
		t.Errorf("filter /sum with summarize skill: got %q want /summarize", s.Completion())
	}
}

func TestSlashAutocompleteMoveDownBoundsClamp(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	for i := 0; i < 100; i++ {
		s.MoveDown()
	}
	if s.Completion() == "" {
		t.Error("after 100 MoveDown, Completion should still return something")
	}
}

func TestSlashAutocompleteMoveUpBoundsClamp(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	s.MoveUp()
	if s.Completion() == "" {
		t.Error("MoveUp on first entry should still have a completion")
	}
}

func TestSlashAutocompleteDismissHides(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	s.Dismiss()
	if s.Visible() {
		t.Error("Dismiss should hide the popup")
	}
}

func TestSlashAutocompleteViewRendersMatchedEntries(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/com")
	out := s.View(60)
	if !strings.Contains(out, "/compact") {
		t.Errorf("view should include /compact: %q", out)
	}
}

func TestSlashAutocompleteViewHiddenWhenNotVisible(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	out := s.View(60)
	if out != "" {
		t.Errorf("hidden view should be empty: %q", out)
	}
}

func TestSlashAutocompleteNoMatchesViewEmpty(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/zxqyabc")
	out := s.View(60)
	if out != "" {
		t.Errorf("no-match view should be empty: %q", out)
	}
}

func TestSlashAutocompleteEntriesSortedAlphabetically(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	out := s.View(80)
	// /compact comes before /expand alphabetically
	compactIdx := strings.Index(out, "/compact")
	expandIdx := strings.Index(out, "/expand")
	if compactIdx < 0 || expandIdx < 0 {
		t.Errorf("missing entries: compact=%d expand=%d in %q", compactIdx, expandIdx, out)
	}
	if compactIdx >= expandIdx {
		t.Errorf("entries not sorted: /compact@%d should be before /expand@%d", compactIdx, expandIdx)
	}
}

func TestSlashAutocompleteMatchesCapAt10(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	skills := make([]transport.Skill, 15)
	for i := range skills {
		skills[i] = transport.Skill{
			Name:        "skill-many-" + string(rune('a'+i)),
			Description: "test",
		}
	}
	s.SetSkills(skills)
	s.SetFilter("/")
	// Force regeneration after SetSkills.
	s.SetFilter("/")
	matchCount := strings.Count(s.View(80), "skill-many-") + strings.Count(s.View(80), "/compact")
	if matchCount > 10*2 { // each /entry could appear twice (name + dim); 10 is the cap on entries
		t.Errorf("matches not capped at 10: got %d", matchCount)
	}
}

// M9.6 T1 — mouse-click helpers.

func TestSlashAutocompleteSelectAtSelectsEntry(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	completion, ok := s.SelectAt(0)
	if !ok {
		t.Error("SelectAt(0) should resolve")
	}
	if completion == "" {
		t.Error("Completion should be non-empty")
	}
}

func TestSlashAutocompleteSelectAtOutOfRangeReturnsFalse(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	_, ok := s.SelectAt(999)
	if ok {
		t.Error("SelectAt(999) should return false")
	}
	_, ok = s.SelectAt(-1)
	if ok {
		t.Error("SelectAt(-1) should return false")
	}
}

func TestSlashAutocompletePopupHeightIncludesBorder(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetFilter("/")
	h := s.PopupHeight()
	if h <= 0 {
		t.Errorf("PopupHeight should be > 0 when visible; got %d", h)
	}
}

func TestSlashAutocompletePopupHeightZeroWhenHidden(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	h := s.PopupHeight()
	if h != 0 {
		t.Errorf("PopupHeight hidden should be 0; got %d", h)
	}
}

// Backlog #45 — dynamic command list takes precedence over staticEntries.

func TestSlashAutocompleteSetCommandsReplacesStatic(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	// Inject a custom command set including one name NOT in staticEntries.
	s.SetCommands([]transport.CommandDescriptor{
		{Name: "synthetic-only", Description: "test entry not in staticEntries"},
	})
	s.SetFilter("/syn")
	if s.Completion() != "/synthetic-only" {
		t.Errorf("dynamic command list should drive matches; got %q want /synthetic-only", s.Completion())
	}
}

func TestSlashAutocompleteSetCommandsHidesStaticEntries(t *testing.T) {
	// When commands is set, staticEntries should NOT contribute. Test by
	// filtering on a name that's only in staticEntries (e.g., "/clear")
	// after SetCommands swaps in a list that doesn't include it.
	s := NewSlashAutocomplete(theme.Dark())
	s.SetCommands([]transport.CommandDescriptor{
		{Name: "only-foo", Description: "single-entry dynamic list"},
	})
	s.SetFilter("/cle")
	if s.Completion() != "" {
		t.Errorf("staticEntries should be hidden when commands is set; got completion %q", s.Completion())
	}
}

func TestSlashAutocompleteEmptyCommandsFallsBackToStatic(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	// SetCommands with empty list = no override. Static fallback active.
	s.SetCommands([]transport.CommandDescriptor{})
	s.SetFilter("/comp")
	if s.Completion() != "/compact" {
		t.Errorf("empty commands list should fall back to staticEntries; got %q want /compact", s.Completion())
	}
}

func TestSlashAutocompleteDynamicCommandsAndSkillsCoexist(t *testing.T) {
	s := NewSlashAutocomplete(theme.Dark())
	s.SetCommands([]transport.CommandDescriptor{
		{Name: "help", Description: "list available slash commands"},
	})
	s.SetSkills([]transport.Skill{
		{Name: "summarize", Description: "summarize the conversation"},
	})
	s.SetFilter("/")
	out := s.View(80)
	if !strings.Contains(out, "/help") {
		t.Errorf("expected /help (dynamic command) in view: %q", out)
	}
	if !strings.Contains(out, "/summarize") {
		t.Errorf("expected /summarize (skill) in view: %q", out)
	}
}
