package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
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

// 2026-05-24 patch — task-routing status surfaces in the profile column.

func TestStatusLine_TaskRouterReplacesProfileColumn(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.TaskRouter = "frugal-anthropic"
	out := s.View()
	if !strings.Contains(out, "Task Router Active (frugal-anthropic)") {
		t.Errorf("expected 'Task Router Active (frugal-anthropic)' in view, got %q", out)
	}
	if strings.Contains(out, "default") {
		t.Errorf("profile column should be replaced when TaskRouter is set; got %q", out)
	}
}

func TestStatusLine_TaskRouterEmptyFallsBackToProfile(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.TaskRouter = ""
	out := s.View()
	if !strings.Contains(out, "default") {
		t.Errorf("empty TaskRouter should keep default profile; got %q", out)
	}
	if strings.Contains(out, "Task Router Active") {
		t.Errorf("empty TaskRouter should NOT show router label; got %q", out)
	}
}

func TestStatusLine_TaskRouterCustomLabel(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.TaskRouter = "custom"
	out := s.View()
	if !strings.Contains(out, "Task Router Active (custom)") {
		t.Errorf("expected 'Task Router Active (custom)' for custom routing; got %q", out)
	}
}

// Slice D / T7 — reasoning-depth level surfaces in the left column once
// the /effort side-effect (effortChanged) sets it.

func TestStatusLine_EffortRendersWhenSet(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	s.Effort = "high"
	out := s.View()
	if !strings.Contains(out, "effort:high") {
		t.Errorf("expected 'effort:high' in view once set, got %q", out)
	}
}

func TestStatusLine_EffortAbsentWhenEmpty(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(80)
	// Default (empty) — the effort field must not appear at all, so the
	// status line is unchanged until the user first runs /effort.
	out := s.View()
	if strings.Contains(out, "effort:") {
		t.Errorf("empty Effort should not render the field; got %q", out)
	}
}

// 2026-06-14 config live-apply (M6) — permission-mode indicator slot.

func TestStatusLine_PermissionModeBypassRendersLoudChip(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(120)
	s.PermissionMode = "bypass"
	out := s.View()
	// The loud chip uppercases the mode + leads with the warning glyph.
	if !strings.Contains(out, "BYPASS") {
		t.Errorf("expected loud 'BYPASS' chip for bypass mode; got %q", out)
	}
	if !strings.Contains(out, "⚠") {
		t.Errorf("expected warning glyph on the bypass chip; got %q", out)
	}
}

func TestStatusLine_PermissionModeNonDefaultRendersQuietChip(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(120)
	s.PermissionMode = "plan"
	out := s.View()
	if !strings.Contains(out, "PLAN") {
		t.Errorf("expected 'PLAN' chip for plan mode; got %q", out)
	}
	// The quiet chip must NOT carry the loud warning glyph (that's reserved
	// for bypass — the only mode that disables every approval gate).
	if strings.Contains(out, "⚠") {
		t.Errorf("non-bypass mode should not show the warning glyph; got %q", out)
	}
}

func TestStatusLine_PermissionModeDefaultRendersNothing(t *testing.T) {
	for _, mode := range []string{"", "default"} {
		s := NewStatusLine(theme.Dark())
		s.SetWidth(120)
		s.PermissionMode = mode
		out := s.View()
		for _, leak := range []string{"BYPASS", "DEFAULT", "⚠"} {
			if strings.Contains(out, leak) {
				t.Errorf("mode=%q should render no chip; got %q (leak %q)", mode, out, leak)
			}
		}
	}
}

// 2026-06-15 patch — subscription-executor posture chip. Mirrors the loud
// bypass permission chip because it's the same "no approval gate" posture.

func TestStatusLine_SubscriptionExecutorRendersLoudChip(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(120)
	s.SubscriptionExecutor = true
	out := s.View()
	if !strings.Contains(out, "SUB-EXEC") {
		t.Errorf("expected loud 'SUB-EXEC' chip when SubscriptionExecutor is on; got %q", out)
	}
	// The loud chip leads with the warning glyph (same as the bypass chip).
	if !strings.Contains(out, "⚠") {
		t.Errorf("expected warning glyph on the subscription-executor chip; got %q", out)
	}
}

func TestStatusLine_SubscriptionExecutorOffRendersNothing(t *testing.T) {
	s := NewStatusLine(theme.Dark())
	s.SetWidth(120)
	// Default (false) — no chip at all.
	out := s.View()
	if strings.Contains(out, "SUB-EXEC") {
		t.Errorf("SubscriptionExecutor off should render no chip; got %q", out)
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
