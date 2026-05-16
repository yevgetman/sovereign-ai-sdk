package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestStallBadgeRendersReason(t *testing.T) {
	b := StallBadge{Reason: "no edits", Theme: theme.Dark()}
	out := b.View(80)
	if !strings.Contains(out, "stalled") {
		t.Errorf("badge missing 'stalled': %q", out)
	}
	if !strings.Contains(out, "no edits") {
		t.Errorf("badge missing reason: %q", out)
	}
}

func TestStallBadgeNoReasonStillRenders(t *testing.T) {
	b := StallBadge{Theme: theme.Dark()}
	out := b.View(80)
	if !strings.Contains(out, "stalled") {
		t.Errorf("badge missing 'stalled' without reason: %q", out)
	}
}

func TestStallBadgeZeroWidthReturnsEmpty(t *testing.T) {
	b := StallBadge{Reason: "x", Theme: theme.Dark()}
	out := b.View(0)
	if out != "" {
		t.Errorf("zero width: expected empty, got %q", out)
	}
}

func TestStallBadgeLightThemeRenders(t *testing.T) {
	b := StallBadge{Reason: "stuck", Theme: theme.Light()}
	out := b.View(80)
	if !strings.Contains(out, "stuck") {
		t.Errorf("light theme badge missing reason: %q", out)
	}
}
