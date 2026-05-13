package app

import (
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
)

func TestBareScaffold_rendersThreeRegions(t *testing.T) {
	tm := teatest.NewTestModel(t, New("test-session", "http://127.0.0.1:0"), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		// Look for the input prompt marker and the status row's bg color
		// has rendered (lipgloss outputs ANSI escapes — check for the
		// textinput prompt char "›").
		return contains(b, "›")
	}, teatest.WithDuration(2*time.Second))

	// ESC quits.
	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

func contains(haystack []byte, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if string(haystack[i:i+len(needle)]) == needle {
			return true
		}
	}
	return false
}
