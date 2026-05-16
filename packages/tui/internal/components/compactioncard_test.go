package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestCompactionCardRendersTokenDeltas(t *testing.T) {
	out := RenderCompactionCard(1000, 500, "abc12345", theme.Dark(), 80)
	for _, want := range []string{"1000", "500", "abc12345", "compacted"} {
		if !strings.Contains(out, want) {
			t.Errorf("compaction card missing %q: %q", want, out)
		}
	}
}

func TestCompactionCardSmallWidthFallsBackToPlain(t *testing.T) {
	out := RenderCompactionCard(1000, 500, "abc12345", theme.Dark(), 3)
	if !strings.Contains(out, "compacted") {
		t.Errorf("small-width fallback missing 'compacted': %q", out)
	}
}

func TestCompactionCardLightThemeRenders(t *testing.T) {
	out := RenderCompactionCard(100, 50, "abc123", theme.Light(), 80)
	if !strings.Contains(out, "100") {
		t.Errorf("light theme: missing before-token count: %q", out)
	}
}

func TestCompactionCardZeroTokensRenders(t *testing.T) {
	out := RenderCompactionCard(0, 0, "abc", theme.Dark(), 80)
	// Should not panic; "0→0" should be in output.
	if !strings.Contains(out, "0") {
		t.Errorf("zero-token compaction missing tokens: %q", out)
	}
}
