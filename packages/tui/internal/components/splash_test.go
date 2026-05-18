// Splash render tests — pin layout decisions (side-by-side vs stacked),
// gradient application, and tips-line presence. Visual fidelity is
// validated by hand against the REPL splash; this file pins the
// behavioral invariants.

package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestRenderSplash_ContainsLogo(t *testing.T) {
	out := RenderSplash(SplashInfo{
		Version:  "0.0.1",
		Provider: "anthropic",
		Auth:     "API Key",
		Model:    "claude-haiku-4-5-20251001",
		Cwd:      "/home/user/code",
	}, theme.Dark(), 120)

	// One row of the ANSI Shadow "SOV" art — pinning a uniquely identifiable
	// substring so reflows don't break the assertion.
	if !strings.Contains(out, "███████╗") {
		t.Errorf("rendered splash missing SOV logo glyph; got:\n%s", out)
	}
}

func TestRenderSplash_ContainsInfoCard(t *testing.T) {
	out := RenderSplash(SplashInfo{
		Version:  "1.2.3",
		Provider: "anthropic",
		Auth:     "API Key",
		Model:    "claude-haiku-4-5-20251001",
		Cwd:      "/home/user/code",
	}, theme.Dark(), 120)

	if !strings.Contains(out, "Sovereign AI") {
		t.Errorf("info card missing Sovereign AI title; got:\n%s", out)
	}
	if !strings.Contains(out, "1.2.3") {
		t.Errorf("info card missing version; got:\n%s", out)
	}
	if !strings.Contains(out, "anthropic") {
		t.Errorf("info card missing provider; got:\n%s", out)
	}
	if !strings.Contains(out, "API Key") {
		t.Errorf("info card missing auth; got:\n%s", out)
	}
	if !strings.Contains(out, "claude-haiku-4-5-20251001") {
		t.Errorf("info card missing model; got:\n%s", out)
	}
	if !strings.Contains(out, "/home/user/code") {
		t.Errorf("info card missing cwd; got:\n%s", out)
	}
}

func TestRenderSplash_OmitsEmptyFields(t *testing.T) {
	// A fresh-session boot before status_update arrives may have empty
	// Model. The splash should render cleanly without an empty model line.
	out := RenderSplash(SplashInfo{
		Version:  "0.0.1",
		Provider: "anthropic",
		Auth:     "API Key",
		// Model deliberately omitted.
		Cwd: "/home/user/code",
	}, theme.Dark(), 120)

	if strings.Contains(out, "(/model to change)") {
		t.Errorf("splash should omit /model hint when Model field is empty; got:\n%s", out)
	}
}

func TestRenderSplash_AppendsTipsLine(t *testing.T) {
	out := RenderSplash(SplashInfo{
		Version: "0.0.1",
		Tips:    "Tips: type / for slash commands",
	}, theme.Dark(), 120)

	if !strings.Contains(out, "Tips: type") {
		t.Errorf("tips line missing; got:\n%s", out)
	}
}

func TestRenderSplash_StacksOnNarrowTerminal(t *testing.T) {
	// At width 40, the logo + card can't sit side-by-side, so the
	// renderer stacks. The output should still contain both the logo and
	// the card.
	out := RenderSplash(SplashInfo{
		Version:  "0.0.1",
		Provider: "anthropic",
		Auth:     "API Key",
		Model:    "claude-haiku-4-5-20251001",
		Cwd:      "/home/user/code",
	}, theme.Dark(), 40)

	if !strings.Contains(out, "███████╗") {
		t.Errorf("stacked splash should still show logo; got:\n%s", out)
	}
	if !strings.Contains(out, "Sovereign AI") {
		t.Errorf("stacked splash should still show info card; got:\n%s", out)
	}
}

func TestRenderSplash_DropsLogoOnPathologicallyNarrowTerminal(t *testing.T) {
	// Below the logo's intrinsic width, the renderer skips the logo
	// rather than fragment the box-drawing glyphs.
	out := RenderSplash(SplashInfo{
		Version: "0.0.1",
		Cwd:     "/short",
	}, theme.Dark(), 20)

	if strings.Contains(out, "███████╗") {
		t.Errorf("pathologically-narrow splash should drop logo; got:\n%s", out)
	}
	if !strings.Contains(out, "Sovereign AI") {
		t.Errorf("pathologically-narrow splash should still show info card; got:\n%s", out)
	}
}

func TestRenderSplash_NoCrashOnZeroWidth(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("RenderSplash panicked on width=0: %v", r)
		}
	}()
	// Zero width should fall through to a sane default (80) rather than
	// dividing by zero or producing negative-padded output.
	_ = RenderSplash(SplashInfo{Version: "x"}, theme.Dark(), 0)
}

func TestRenderSplash_AppliesGradientPerRow(t *testing.T) {
	// The colorize helper applies a distinct lipgloss foreground for
	// each row. We can't compare raw hex (lipgloss may strip styles in
	// non-TTY contexts), but we CAN verify each logo row appears in the
	// output.
	out := RenderSplash(SplashInfo{
		Version: "0.0.1",
	}, theme.Dark(), 120)

	for _, row := range logoLines {
		// Strip the leading two-space gutter from the source string
		// since lipgloss may rewrap. Use the central glyph as a probe.
		core := strings.TrimSpace(row)
		if core == "" {
			continue
		}
		if !strings.Contains(out, core) {
			t.Errorf("expected logo row to appear in output:\n  %q\nfull output:\n%s", core, out)
		}
	}
}
