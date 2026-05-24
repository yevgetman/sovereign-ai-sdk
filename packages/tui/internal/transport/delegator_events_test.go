// Phase 2 T5 — wire-shape tests for the four delegator_* SSE event
// decoders. Mirrors the precedent set by types_test.go and pins the
// JSON-field contract against src/router/progressEvents.ts.

package transport

import (
	"encoding/json"
	"testing"
)

// TestDecodeDelegatorPlan_minimal pins the minimal shape (no
// scheduledAtomCount; the field is optional today). A regression that
// dropped omitempty would surface as a 0 in the decoded struct, which
// the test catches via the nil pointer assertion.
func TestDecodeDelegatorPlan_minimal(t *testing.T) {
	raw := `{"type":"delegator_plan","seq":7,"sessionId":"s-root"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("envelope decode: %v", err)
	}
	if env.Type != "delegator_plan" {
		t.Fatalf("got type=%q, want delegator_plan", env.Type)
	}
	if env.Seq != 7 {
		t.Fatalf("got seq=%d, want 7", env.Seq)
	}
	ev, err := DecodeDelegatorPlan(env.Raw)
	if err != nil {
		t.Fatalf("decode delegator_plan: %v", err)
	}
	if ev.SessionID != "s-root" {
		t.Fatalf("got sessionId=%q, want s-root", ev.SessionID)
	}
	if ev.ScheduledAtomCount != nil {
		t.Fatalf("ScheduledAtomCount should be nil when absent on the wire, got %v", *ev.ScheduledAtomCount)
	}
}

// TestDecodeDelegatorPlan_withCount covers the reserved field surfaced
// (preserved by the pointer-shaped decoder).
func TestDecodeDelegatorPlan_withCount(t *testing.T) {
	raw := `{"type":"delegator_plan","seq":1,"sessionId":"s","scheduledAtomCount":3}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeDelegatorPlan(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.ScheduledAtomCount == nil || *ev.ScheduledAtomCount != 3 {
		t.Fatalf("ScheduledAtomCount = %v, want 3", ev.ScheduledAtomCount)
	}
}

func TestDecodeDelegatorAtomStarted(t *testing.T) {
	raw := `{"type":"delegator_atom_started","seq":12,"sessionId":"s-root","atomIndex":0,"laneName":"cheap-task","promptPreview":"Summarize this file"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeDelegatorAtomStarted(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.AtomIndex != 0 {
		t.Fatalf("atomIndex = %d, want 0", ev.AtomIndex)
	}
	if ev.LaneName != "cheap-task" {
		t.Fatalf("laneName = %q", ev.LaneName)
	}
	if ev.PromptPreview != "Summarize this file" {
		t.Fatalf("promptPreview = %q", ev.PromptPreview)
	}
}

func TestDecodeDelegatorAtomComplete_success(t *testing.T) {
	raw := `{"type":"delegator_atom_complete","seq":15,"sessionId":"s-root","atomIndex":0,"laneName":"cheap-task","success":true,"durationMs":1234}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeDelegatorAtomComplete(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if !ev.Success {
		t.Fatal("success should be true")
	}
	if ev.DurationMs != 1234 {
		t.Fatalf("durationMs = %d, want 1234", ev.DurationMs)
	}
	if ev.AtomIndex != 0 {
		t.Fatalf("atomIndex = %d, want 0", ev.AtomIndex)
	}
	if ev.LaneName != "cheap-task" {
		t.Fatalf("laneName = %q", ev.LaneName)
	}
}

// TestDecodeDelegatorAtomComplete_failure pins the failure shape — bool
// false in the success column. A typo in the field name on the consumer
// would surface as success=true (zero value) — broken UX (failed atoms
// would render as success).
func TestDecodeDelegatorAtomComplete_failure(t *testing.T) {
	raw := `{"type":"delegator_atom_complete","seq":16,"sessionId":"s-root","atomIndex":1,"laneName":"reasoning","success":false,"durationMs":42}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeDelegatorAtomComplete(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Success {
		t.Fatal("success should be false")
	}
	if ev.AtomIndex != 1 {
		t.Fatalf("atomIndex = %d, want 1", ev.AtomIndex)
	}
	if ev.LaneName != "reasoning" {
		t.Fatalf("laneName = %q", ev.LaneName)
	}
}

func TestDecodeDelegatorComplete(t *testing.T) {
	raw := `{"type":"delegator_complete","seq":99,"sessionId":"s-root","totalAtomCount":3,"laneDistribution":{"cheap-task":2,"reasoning":1}}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeDelegatorComplete(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.TotalAtomCount != 3 {
		t.Fatalf("totalAtomCount = %d, want 3", ev.TotalAtomCount)
	}
	if got, want := ev.LaneDistribution["cheap-task"], 2; got != want {
		t.Fatalf("cheap-task = %d, want %d", got, want)
	}
	if got, want := ev.LaneDistribution["reasoning"], 1; got != want {
		t.Fatalf("reasoning = %d, want %d", got, want)
	}
}

// TestDecodeDelegatorComplete_emptyDistribution covers the no-atoms
// edge case — a delegator turn that exits before dispatching any atoms
// (e.g., the delegator decides nothing needs delegation). Map should be
// empty (not nil-panicked on).
func TestDecodeDelegatorComplete_emptyDistribution(t *testing.T) {
	raw := `{"type":"delegator_complete","seq":1,"sessionId":"s","totalAtomCount":0,"laneDistribution":{}}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	ev, err := DecodeDelegatorComplete(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.TotalAtomCount != 0 {
		t.Fatalf("totalAtomCount = %d, want 0", ev.TotalAtomCount)
	}
	if len(ev.LaneDistribution) != 0 {
		t.Fatalf("laneDistribution should be empty, got %v", ev.LaneDistribution)
	}
}
