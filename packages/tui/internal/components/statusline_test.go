package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestStatusLineDefaultRenders(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	out := s.View()
	if !strings.Contains(out, "default") {
		t.Errorf("default profile not rendered: %q", out)
	}
}

func TestStatusLineSpinnerVisibleWhenStreaming(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.Streaming = true
	out := s.View()
	// Should contain one of the spinner frames.
	hasSpinner := false
	for _, frame := range spinnerFrames {
		if strings.Contains(out, frame) {
			hasSpinner = true
			break
		}
	}
	if !hasSpinner {
		t.Errorf("streaming view missing spinner frame: %q", out)
	}
}

func TestStatusLineSpinnerHiddenWhenNotStreaming(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.Streaming = false
	out := s.View()
	for _, frame := range spinnerFrames {
		if strings.Contains(out, frame) {
			t.Errorf("non-streaming view should not have spinner frame %q: %q", frame, out)
		}
	}
}

func TestStatusLineCostRenders(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.Cost = 0.0042
	out := s.View()
	if !strings.Contains(out, "$0.0042") {
		t.Errorf("cost not rendered: %q", out)
	}
}

func TestStatusLineCacheRenders(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.CacheHit = 0.85
	out := s.View()
	if !strings.Contains(out, "cache 85") {
		t.Errorf("cache hit rate not rendered: %q", out)
	}
}

func TestStatusLineAdvanceSpinnerCycles(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	initial := s.SpinnerFrame()
	s.AdvanceSpinner()
	if s.SpinnerFrame() == initial {
		t.Error("AdvanceSpinner should change the frame")
	}
}

func TestStatusLineAdvanceSpinnerWraps(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	for i := 0; i < len(spinnerFrames)*2; i++ {
		s.AdvanceSpinner()
	}
	// After 2 full cycles the spinner should be back at frame 0.
	if s.SpinnerFrame() != spinnerFrames[0] {
		t.Errorf("spinner wrap: expected %q at cycle-complete, got %q", spinnerFrames[0], s.SpinnerFrame())
	}
}

func TestStatusLineSetThemeSwapsRender(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	darkView := s.View()
	s.SetTheme(theme.Light())
	lightView := s.View()
	// Width and content should be similar, but underlying bg differs.
	// At minimum: both must include the same default cwd marker.
	if !strings.Contains(darkView, "?") || !strings.Contains(lightView, "?") {
		t.Errorf("dark or light view dropped default cwd marker")
	}
}
