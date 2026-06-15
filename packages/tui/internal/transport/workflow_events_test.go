// Multi-agent workflows (2026-06-15) — wire-shape tests for the five
// workflow_* SSE event decoders. Mirrors delegator_events_test.go and pins the
// JSON-field contract against src/workflows/events.ts (the WorkflowEvent
// union). The bus adds seq/sessionId when it publishes; the engine's own event
// shape omits them, so each test covers BOTH the envelope-wrapped wire form and
// the bare engine form.

package transport

import (
	"encoding/json"
	"testing"
)

func TestDecodeWorkflowStarted(t *testing.T) {
	raw := `{"type":"workflow_started","seq":1,"sessionId":"s-root","workflow":"review-changes","phaseCount":3}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("envelope decode: %v", err)
	}
	if env.Type != "workflow_started" {
		t.Fatalf("got type=%q, want workflow_started", env.Type)
	}
	if env.Seq != 1 {
		t.Fatalf("got seq=%d, want 1", env.Seq)
	}
	ev, err := DecodeWorkflowStarted(env.Raw)
	if err != nil {
		t.Fatalf("decode workflow_started: %v", err)
	}
	if ev.Workflow != "review-changes" {
		t.Fatalf("workflow = %q, want review-changes", ev.Workflow)
	}
	if ev.PhaseCount != 3 {
		t.Fatalf("phaseCount = %d, want 3", ev.PhaseCount)
	}
	if ev.SessionID != "s-root" {
		t.Fatalf("sessionId = %q, want s-root", ev.SessionID)
	}
}

// TestDecodeWorkflowStarted_bareEngineShape covers the engine's own event
// shape (no bus-added seq/sessionId) — the decoder must still parse the
// workflow-specific fields rather than erroring on the missing envelope keys.
func TestDecodeWorkflowStarted_bareEngineShape(t *testing.T) {
	raw := []byte(`{"type":"workflow_started","workflow":"deploy","phaseCount":2}`)
	ev, err := DecodeWorkflowStarted(raw)
	if err != nil {
		t.Fatalf("decode bare workflow_started: %v", err)
	}
	if ev.Workflow != "deploy" {
		t.Fatalf("workflow = %q, want deploy", ev.Workflow)
	}
	if ev.PhaseCount != 2 {
		t.Fatalf("phaseCount = %d, want 2", ev.PhaseCount)
	}
	if ev.Seq != 0 || ev.SessionID != "" {
		t.Fatalf("bare shape: seq/sessionId should be zero-valued, got seq=%d sessionId=%q", ev.Seq, ev.SessionID)
	}
}

func TestDecodeWorkflowPhaseStarted(t *testing.T) {
	raw := `{"type":"workflow_phase_started","seq":2,"sessionId":"s","phaseId":"find","index":0,"taskCount":3}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeWorkflowPhaseStarted(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.PhaseID != "find" {
		t.Fatalf("phaseId = %q, want find", ev.PhaseID)
	}
	if ev.Index != 0 {
		t.Fatalf("index = %d, want 0", ev.Index)
	}
	if ev.TaskCount != 3 {
		t.Fatalf("taskCount = %d, want 3", ev.TaskCount)
	}
}

func TestDecodeWorkflowTaskStarted_withLane(t *testing.T) {
	raw := `{"type":"workflow_task_started","seq":3,"sessionId":"s","phaseId":"find","index":1,"label":"security","lane":"frontier"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeWorkflowTaskStarted(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.PhaseID != "find" {
		t.Fatalf("phaseId = %q, want find", ev.PhaseID)
	}
	if ev.Index != 1 {
		t.Fatalf("index = %d, want 1", ev.Index)
	}
	if ev.Label != "security" {
		t.Fatalf("label = %q, want security", ev.Label)
	}
	if ev.Lane != "frontier" {
		t.Fatalf("lane = %q, want frontier", ev.Lane)
	}
}

// TestDecodeWorkflowTaskStarted_noLane pins the optional-lane case: a task with
// no cost-lane override omits the field, which must decode to an empty string.
func TestDecodeWorkflowTaskStarted_noLane(t *testing.T) {
	raw := []byte(`{"type":"workflow_task_started","seq":4,"sessionId":"s","phaseId":"synthesize","index":0,"label":"merge"}`)
	ev, err := DecodeWorkflowTaskStarted(raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Lane != "" {
		t.Fatalf("lane should be empty when absent, got %q", ev.Lane)
	}
	if ev.Label != "merge" {
		t.Fatalf("label = %q, want merge", ev.Label)
	}
}

func TestDecodeWorkflowTaskComplete_success(t *testing.T) {
	raw := []byte(`{"type":"workflow_task_complete","seq":5,"sessionId":"s","phaseId":"find","index":0,"label":"bugs","ok":true}`)
	ev, err := DecodeWorkflowTaskComplete(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !ev.Ok {
		t.Fatal("ok should be true")
	}
	if ev.Label != "bugs" {
		t.Fatalf("label = %q, want bugs", ev.Label)
	}
}

// TestDecodeWorkflowTaskComplete_failure pins the failure shape — ok=false. A
// typo in the field name on the consumer would surface as ok=true (zero value),
// rendering a failed task as a success (broken UX).
func TestDecodeWorkflowTaskComplete_failure(t *testing.T) {
	raw := []byte(`{"type":"workflow_task_complete","seq":6,"sessionId":"s","phaseId":"verify","index":2,"label":"finding-2","ok":false}`)
	ev, err := DecodeWorkflowTaskComplete(raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Ok {
		t.Fatal("ok should be false")
	}
	if ev.Index != 2 {
		t.Fatalf("index = %d, want 2", ev.Index)
	}
}

func TestDecodeWorkflowComplete(t *testing.T) {
	raw := `{"type":"workflow_complete","seq":99,"sessionId":"s-root","workflow":"review-changes","ok":true,"durationMs":1234,"phases":[{"phaseId":"find","total":3,"failed":0},{"phaseId":"verify","total":3,"failed":1}]}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeWorkflowComplete(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Workflow != "review-changes" {
		t.Fatalf("workflow = %q, want review-changes", ev.Workflow)
	}
	if !ev.Ok {
		t.Fatal("ok should be true")
	}
	if ev.DurationMs != 1234 {
		t.Fatalf("durationMs = %d, want 1234", ev.DurationMs)
	}
	if len(ev.Phases) != 2 {
		t.Fatalf("phases len = %d, want 2", len(ev.Phases))
	}
	if ev.Phases[0].PhaseID != "find" || ev.Phases[0].Total != 3 || ev.Phases[0].Failed != 0 {
		t.Fatalf("phase[0] = %+v, want {find 3 0}", ev.Phases[0])
	}
	if ev.Phases[1].PhaseID != "verify" || ev.Phases[1].Total != 3 || ev.Phases[1].Failed != 1 {
		t.Fatalf("phase[1] = %+v, want {verify 3 1}", ev.Phases[1])
	}
}

// TestDecodeWorkflowComplete_emptyPhases covers a workflow with no phases (an
// edge case the renderer's failed-task tally walks); the slice should be empty,
// not nil-panicked on.
func TestDecodeWorkflowComplete_emptyPhases(t *testing.T) {
	raw := []byte(`{"type":"workflow_complete","seq":1,"sessionId":"s","workflow":"noop","ok":true,"durationMs":5,"phases":[]}`)
	ev, err := DecodeWorkflowComplete(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ev.Phases) != 0 {
		t.Fatalf("phases should be empty, got %v", ev.Phases)
	}
}
