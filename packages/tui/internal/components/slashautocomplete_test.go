package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
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
	s.SetFilter("/com")
	completion := s.Completion()
	if completion != "/compact" {
		t.Errorf("filter /com: got %q want /compact", completion)
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
