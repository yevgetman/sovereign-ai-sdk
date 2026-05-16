package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

func TestGoodbyeRichPayloadRendersAllFields(t *testing.T) {
	toolCalls := 5
	toolOk := 4
	toolErr := 1
	cr := 1024
	cw := 256
	apiMs := 1234.0
	summary := transport.SessionSummary{
		TotalDispatched: 2,
		ByAgent:         map[string]int{"review-memory": 1, "review-skill": 1},
		Tokens: &transport.SessionTokens{
			Input:            100,
			Output:           200,
			CacheRead:        &cr,
			CacheWrite:       &cw,
			EstimatedCostUsd: 0.0042,
		},
		ToolCalls: &toolCalls,
		ToolOk:    &toolOk,
		ToolErr:   &toolErr,
		APITimeMs: &apiMs,
	}
	out := RenderGoodbye(summary, theme.Dark(), 120, 40)
	for _, want := range []string{
		"Session summary",
		"tokens in", "100",
		"tokens out", "200",
		"cache read", "1024",
		"cache wrt", "256",
		"$0.0042",
		"tool calls", "5",
		"ok", "4",
		"err", "1",
		"api ms", "1234",
		"forks", "2",
		"review-memory",
		"review-skill",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("goodbye missing %q in:\n%s", want, out)
		}
	}
}

func TestGoodbyeM7ShapeOmitsExtensionFields(t *testing.T) {
	// M7-shape: no tokens, no toolCalls, no durations.
	summary := transport.SessionSummary{
		TotalDispatched: 1,
		ByAgent:         map[string]int{"review-memory": 1},
	}
	out := RenderGoodbye(summary, theme.Dark(), 120, 40)
	// Should still contain forks block.
	if !strings.Contains(out, "forks") {
		t.Errorf("M7-shape goodbye missing forks: %s", out)
	}
	// Should NOT contain rich block markers.
	if strings.Contains(out, "tokens in") {
		t.Errorf("M7-shape goodbye should omit tokens block; got: %s", out)
	}
	if strings.Contains(out, "tool calls") {
		t.Errorf("M7-shape goodbye should omit tool calls block; got: %s", out)
	}
	if strings.Contains(out, "api ms") {
		t.Errorf("M7-shape goodbye should omit duration block; got: %s", out)
	}
}

func TestGoodbyeTokensOnlyOmitsToolBlock(t *testing.T) {
	summary := transport.SessionSummary{
		TotalDispatched: 0,
		ByAgent:         map[string]int{},
		Tokens: &transport.SessionTokens{
			Input:            10,
			Output:           20,
			EstimatedCostUsd: 0.001,
		},
	}
	out := RenderGoodbye(summary, theme.Dark(), 120, 40)
	if !strings.Contains(out, "tokens in") {
		t.Errorf("tokens-only goodbye missing tokens block: %s", out)
	}
	if strings.Contains(out, "tool calls") {
		t.Errorf("tokens-only goodbye should not show tool block: %s", out)
	}
}

func TestGoodbyeZeroDimensionsReturnsEmpty(t *testing.T) {
	out := RenderGoodbye(transport.SessionSummary{}, theme.Dark(), 0, 0)
	if out != "" {
		t.Errorf("zero dims: expected empty, got %q", out)
	}
}

func TestGoodbyeLightThemeRenders(t *testing.T) {
	summary := transport.SessionSummary{TotalDispatched: 0, ByAgent: map[string]int{}}
	out := RenderGoodbye(summary, theme.Light(), 80, 30)
	if !strings.Contains(out, "Session summary") {
		t.Errorf("light theme goodbye missing title: %s", out)
	}
}

func TestGoodbyeAgentsSortedDeterministically(t *testing.T) {
	summary := transport.SessionSummary{
		TotalDispatched: 3,
		ByAgent: map[string]int{
			"zeta":  1,
			"alpha": 2,
			"mu":    1,
		},
	}
	out := RenderGoodbye(summary, theme.Dark(), 120, 40)
	alphaIdx := strings.Index(out, "alpha")
	muIdx := strings.Index(out, "mu")
	zetaIdx := strings.Index(out, "zeta")
	if alphaIdx >= muIdx || muIdx >= zetaIdx {
		t.Errorf("agents not alphabetically sorted: alpha=%d mu=%d zeta=%d", alphaIdx, muIdx, zetaIdx)
	}
}
