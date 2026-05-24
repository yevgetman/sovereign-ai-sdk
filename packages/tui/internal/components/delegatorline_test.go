// Phase 2 T5 — formatter tests for the four delegator_* event lines.
// Reuses the package-local stripANSI helper from compactline_test.go so
// assertions inspect plain text rather than depending on specific ANSI
// codes lipgloss emits.

package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

func TestFormatDelegatorPlanLine_noScheduledCount(t *testing.T) {
	ev := transport.DelegatorPlanEvent{
		Type:      "delegator_plan",
		Seq:       1,
		SessionID: "s",
	}
	out := FormatDelegatorPlanLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Delegating") {
		t.Errorf("expected 'Delegating' in plan line, got %q", plain)
	}
	if !strings.Contains(plain, DelegatorPlanGlyph) {
		t.Errorf("expected plan glyph %q in plan line, got %q", DelegatorPlanGlyph, plain)
	}
	// Without scheduledAtomCount we render an ellipsis to signal "plan is
	// unfolding atom-by-atom".
	if !strings.Contains(plain, "…") {
		t.Errorf("expected ellipsis tail when count absent, got %q", plain)
	}
}

func TestFormatDelegatorPlanLine_withScheduledCount(t *testing.T) {
	n := 3
	ev := transport.DelegatorPlanEvent{
		Type:               "delegator_plan",
		Seq:                1,
		SessionID:          "s",
		ScheduledAtomCount: &n,
	}
	out := FormatDelegatorPlanLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, "3 atom(s) planned") {
		t.Errorf("expected '3 atom(s) planned' when count set, got %q", plain)
	}
}

func TestFormatDelegatorAtomStartedLine_includesIdxLaneAndPreview(t *testing.T) {
	ev := transport.DelegatorAtomStartedEvent{
		Type:          "delegator_atom_started",
		Seq:           2,
		SessionID:     "s",
		AtomIndex:     0,
		LaneName:      "cheap-task",
		PromptPreview: "Summarize this file",
	}
	out := FormatDelegatorAtomStartedLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, DelegatorAtomStartGlyph) {
		t.Errorf("expected start glyph %q, got %q", DelegatorAtomStartGlyph, plain)
	}
	if !strings.Contains(plain, "atom 0 on cheap-task") {
		t.Errorf("expected 'atom 0 on cheap-task', got %q", plain)
	}
	if !strings.Contains(plain, "Summarize this file") {
		t.Errorf("expected preview text, got %q", plain)
	}
}

// TestFormatDelegatorAtomStartedLine_omitsPreviewWhenEmpty exercises the
// edge case where the preview was empty (or the server elided it). The
// line should still render legibly without a stray trailing ": ".
func TestFormatDelegatorAtomStartedLine_omitsPreviewWhenEmpty(t *testing.T) {
	ev := transport.DelegatorAtomStartedEvent{
		Type:          "delegator_atom_started",
		Seq:           2,
		SessionID:     "s",
		AtomIndex:     2,
		LaneName:      "reasoning",
		PromptPreview: "",
	}
	out := FormatDelegatorAtomStartedLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, "atom 2 on reasoning") {
		t.Errorf("expected 'atom 2 on reasoning', got %q", plain)
	}
	if strings.HasSuffix(plain, ":") || strings.Contains(plain, ": ") {
		t.Errorf("expected no trailing ': ' when preview empty, got %q", plain)
	}
}

func TestFormatDelegatorAtomCompleteLine_success(t *testing.T) {
	ev := transport.DelegatorAtomCompleteEvent{
		Type:       "delegator_atom_complete",
		Seq:        3,
		SessionID:  "s",
		AtomIndex:  0,
		LaneName:   "cheap-task",
		Success:    true,
		DurationMs: 1234,
	}
	out := FormatDelegatorAtomCompleteLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, DelegatorAtomSuccessGlyph) {
		t.Errorf("expected success glyph %q, got %q", DelegatorAtomSuccessGlyph, plain)
	}
	if !strings.Contains(plain, "atom 0 on cheap-task") {
		t.Errorf("expected 'atom 0 on cheap-task', got %q", plain)
	}
	if !strings.Contains(plain, "(1234ms)") {
		t.Errorf("expected '(1234ms)', got %q", plain)
	}
	if strings.Contains(plain, "failed") {
		t.Errorf("success line should not contain 'failed', got %q", plain)
	}
}

func TestFormatDelegatorAtomCompleteLine_failure(t *testing.T) {
	ev := transport.DelegatorAtomCompleteEvent{
		Type:       "delegator_atom_complete",
		Seq:        4,
		SessionID:  "s",
		AtomIndex:  1,
		LaneName:   "reasoning",
		Success:    false,
		DurationMs: 42,
	}
	out := FormatDelegatorAtomCompleteLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, DelegatorAtomFailureGlyph) {
		t.Errorf("expected failure glyph %q, got %q", DelegatorAtomFailureGlyph, plain)
	}
	if !strings.Contains(plain, "atom 1 on reasoning") {
		t.Errorf("expected 'atom 1 on reasoning', got %q", plain)
	}
	if !strings.Contains(plain, "failed (42ms)") {
		t.Errorf("expected 'failed (42ms)', got %q", plain)
	}
}

func TestFormatDelegatorCompleteLine_includesCountAndDistribution(t *testing.T) {
	ev := transport.DelegatorCompleteEvent{
		Type:           "delegator_complete",
		Seq:            5,
		SessionID:      "s",
		TotalAtomCount: 3,
		LaneDistribution: map[string]int{
			"cheap-task": 2,
			"reasoning":  1,
		},
	}
	out := FormatDelegatorCompleteLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Done.") {
		t.Errorf("expected 'Done.' in summary line, got %q", plain)
	}
	if !strings.Contains(plain, DelegatorCompleteGlyph) {
		t.Errorf("expected complete glyph %q, got %q", DelegatorCompleteGlyph, plain)
	}
	if !strings.Contains(plain, "3 atom(s)") {
		t.Errorf("expected '3 atom(s)', got %q", plain)
	}
	if !strings.Contains(plain, "cheap-task=2") {
		t.Errorf("expected 'cheap-task=2', got %q", plain)
	}
	if !strings.Contains(plain, "reasoning=1") {
		t.Errorf("expected 'reasoning=1', got %q", plain)
	}
}

// TestFormatDelegatorCompleteLine_sortOrder pins the sort contract:
// count desc, then name asc. Without this, identical turns could produce
// different strings depending on Go's randomized map iteration order.
func TestFormatDelegatorCompleteLine_sortOrder(t *testing.T) {
	ev := transport.DelegatorCompleteEvent{
		Type:           "delegator_complete",
		Seq:            5,
		SessionID:      "s",
		TotalAtomCount: 6,
		LaneDistribution: map[string]int{
			// Mix counts and names so a wrong sort surfaces in either axis.
			"alpha":      1, // tie at 1 — should sort alphabetically before "beta"
			"beta":       1,
			"cheap-task": 3, // highest — first
			"reasoning":  2, // second
		},
	}
	out := FormatDelegatorCompleteLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	// The four entries should appear in this exact order in the rendered text.
	expectedOrder := []string{"cheap-task=3", "reasoning=2", "alpha=1", "beta=1"}
	last := 0
	for _, frag := range expectedOrder {
		idx := strings.Index(plain, frag)
		if idx < 0 {
			t.Fatalf("expected fragment %q in line, got %q", frag, plain)
		}
		if idx < last {
			t.Errorf("expected %q to appear after the previous fragment in order %v, got line %q",
				frag, expectedOrder, plain)
		}
		last = idx
	}
}

// TestFormatDelegatorCompleteLine_emptyDistribution covers the no-atoms
// edge — the summary should still render the "Done. 0 atom(s)" headline
// without trailing ": " or panicking on the empty map.
func TestFormatDelegatorCompleteLine_emptyDistribution(t *testing.T) {
	ev := transport.DelegatorCompleteEvent{
		Type:             "delegator_complete",
		Seq:              5,
		SessionID:        "s",
		TotalAtomCount:   0,
		LaneDistribution: map[string]int{},
	}
	out := FormatDelegatorCompleteLine(ev, theme.Dark(), 80)
	plain := stripANSI(out)
	if !strings.Contains(plain, "0 atom(s)") {
		t.Errorf("expected '0 atom(s)' with empty map, got %q", plain)
	}
	if strings.Contains(plain, ": ") {
		t.Errorf("expected no ': ' separator when distribution empty, got %q", plain)
	}
}
