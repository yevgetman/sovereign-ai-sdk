// Multi-agent workflows (2026-06-15) — render tests for the five workflow_*
// SSE events. Drives handleEvent directly (matching the M9 T11 precedent in
// app_test.go) and asserts the rendered line lands in m.pendingPrintln with the
// expected visible text (ANSI stripped). White-box (package app) so we can read
// the queued-print buffer and call the pointer-receiver render helpers via
// handleEvent. Decode is pinned in transport/workflow_events_test.go; here we
// pin the SSE-switch case + the single-line render content.

package app

import (
	"regexp"
	"strings"
	"testing"
)

var ansiSeq = regexp.MustCompile("\x1b\\[[0-9;]*m")

// stripANSI removes SGR escape sequences so assertions match visible text.
func stripANSI(s string) string {
	return ansiSeq.ReplaceAllString(s, "")
}

// joinPrints returns all queued print lines joined, ANSI-stripped, for
// substring assertions across the breathing-room blank lines the handler emits.
func joinPrints(m *Model) string {
	return stripANSI(strings.Join(m.pendingPrintln, "\n"))
}

func newWorkflowTestModel() *Model {
	m := New("s-wf", "")
	return &m
}

func driveWorkflowEvent(t *testing.T, m *Model, eventType, raw string) {
	t.Helper()
	m.handleEvent(newTestEnvelope(eventType, "s-wf", 1, raw))
}

func TestWorkflowStarted_rendersHeaderLine(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_started",
		`{"type":"workflow_started","seq":1,"sessionId":"s-wf","workflow":"review-changes","phaseCount":3}`)
	out := joinPrints(m)
	if !strings.Contains(out, "Workflow review-changes") {
		t.Fatalf("missing workflow name header in %q", out)
	}
	if !strings.Contains(out, "3 phase(s)") {
		t.Fatalf("missing phase count in %q", out)
	}
}

func TestWorkflowPhaseStarted_rendersPhaseLine(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_phase_started",
		`{"type":"workflow_phase_started","seq":2,"sessionId":"s-wf","phaseId":"find","index":0,"taskCount":3}`)
	out := joinPrints(m)
	// index 0 → "phase 1" (1-based for the user).
	if !strings.Contains(out, "phase 1: find") {
		t.Fatalf("missing 1-based phase line in %q", out)
	}
	if !strings.Contains(out, "3 task(s)") {
		t.Fatalf("missing task count in %q", out)
	}
}

func TestWorkflowTaskStarted_rendersWithLane(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_task_started",
		`{"type":"workflow_task_started","seq":3,"sessionId":"s-wf","phaseId":"find","index":1,"label":"security","lane":"frontier"}`)
	out := joinPrints(m)
	if !strings.Contains(out, "find/security") {
		t.Fatalf("missing phaseId/label in %q", out)
	}
	if !strings.Contains(out, "(frontier)") {
		t.Fatalf("missing lane suffix in %q", out)
	}
}

func TestWorkflowTaskStarted_noLaneOmitsSuffix(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_task_started",
		`{"type":"workflow_task_started","seq":3,"sessionId":"s-wf","phaseId":"synthesize","index":0,"label":"merge"}`)
	out := joinPrints(m)
	if !strings.Contains(out, "synthesize/merge") {
		t.Fatalf("missing phaseId/label in %q", out)
	}
	if strings.Contains(out, "()") {
		t.Fatalf("empty lane parens should be omitted in %q", out)
	}
}

func TestWorkflowTaskComplete_successGlyph(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_task_complete",
		`{"type":"workflow_task_complete","seq":4,"sessionId":"s-wf","phaseId":"find","index":0,"label":"bugs","ok":true}`)
	out := joinPrints(m)
	if !strings.Contains(out, "✓") {
		t.Fatalf("success glyph missing in %q", out)
	}
	if strings.Contains(out, "✗") {
		t.Fatalf("failure glyph should be absent on success in %q", out)
	}
	if !strings.Contains(out, "find/bugs") {
		t.Fatalf("missing phaseId/label in %q", out)
	}
}

func TestWorkflowTaskComplete_failureGlyph(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_task_complete",
		`{"type":"workflow_task_complete","seq":5,"sessionId":"s-wf","phaseId":"verify","index":2,"label":"finding-2","ok":false}`)
	out := joinPrints(m)
	if !strings.Contains(out, "✗") {
		t.Fatalf("failure glyph missing in %q", out)
	}
	if !strings.Contains(out, "verify/finding-2") {
		t.Fatalf("missing phaseId/label in %q", out)
	}
}

func TestWorkflowComplete_summaryOk(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_complete",
		`{"type":"workflow_complete","seq":99,"sessionId":"s-wf","workflow":"review-changes","ok":true,"durationMs":1234,"phases":[{"phaseId":"find","total":3,"failed":0},{"phaseId":"verify","total":3,"failed":0}]}`)
	out := joinPrints(m)
	if !strings.Contains(out, "review-changes complete") {
		t.Fatalf("missing complete summary in %q", out)
	}
	if !strings.Contains(out, "0 failed task(s)") {
		t.Fatalf("expected 0 failed in %q", out)
	}
	if !strings.Contains(out, "1234ms") {
		t.Fatalf("missing duration in %q", out)
	}
}

func TestWorkflowComplete_summaryWithErrors(t *testing.T) {
	m := newWorkflowTestModel()
	driveWorkflowEvent(t, m, "workflow_complete",
		`{"type":"workflow_complete","seq":99,"sessionId":"s-wf","workflow":"review-changes","ok":false,"durationMs":50,"phases":[{"phaseId":"find","total":3,"failed":1},{"phaseId":"verify","total":2,"failed":1}]}`)
	out := joinPrints(m)
	if !strings.Contains(out, "completed with errors") {
		t.Fatalf("missing error summary in %q", out)
	}
	// failed tally sums across phases: 1 + 1 = 2.
	if !strings.Contains(out, "2 failed task(s)") {
		t.Fatalf("expected 2 failed (summed across phases) in %q", out)
	}
}

// TestWorkflowEvent_malformedRawIsDropped pins the defensive decode-error
// branch: a malformed payload must NOT panic and must queue nothing (the
// handler returns early on decode error, like every other SSE case).
func TestWorkflowEvent_malformedRawIsDropped(t *testing.T) {
	m := newWorkflowTestModel()
	before := len(m.pendingPrintln)
	m.handleEvent(newTestEnvelope("workflow_complete", "s-wf", 1, `{"type":"workflow_complete","durationMs":"not-a-number"}`))
	if len(m.pendingPrintln) != before {
		t.Fatalf("malformed event should queue nothing, got %d new lines: %v",
			len(m.pendingPrintln)-before, m.pendingPrintln[before:])
	}
}
