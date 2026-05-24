// Phase 2 T5 — Go decoders for the four delegator_* SSE events
// synthesized by the runtime (Phase 2 T4) when the smart router is on.
//
// Mirrors src/router/progressEvents.ts (zod schemas at lines 63-95).
// The wire shapes:
//
//	delegator_plan          { type, seq, sessionId, scheduledAtomCount? }
//	delegator_atom_started  { type, seq, sessionId, atomIndex, laneName, promptPreview }
//	delegator_atom_complete { type, seq, sessionId, atomIndex, laneName, success, durationMs }
//	delegator_complete      { type, seq, sessionId, totalAtomCount, laneDistribution }
//
// All four are publish-only — the runtime emits them onto the per-session
// bus; the TUI consumes them in app.go's SSE switch and renders via
// components.FormatDelegator*Line.

package transport

import "encoding/json"

// DelegatorPlanEvent marks the start of a delegator turn — when the runtime
// dispatches the `delegator` sub-agent. `ScheduledAtomCount` is a pointer
// because the delegator does NOT pre-declare its plan (atoms are dispatched
// one at a time); the value is nil today and reserved for future use.
type DelegatorPlanEvent struct {
	Type               string `json:"type"`
	Seq                int64  `json:"seq"`
	SessionID          string `json:"sessionId"`
	ScheduledAtomCount *int   `json:"scheduledAtomCount,omitempty"`
}

// DelegatorAtomStartedEvent marks an atom dispatch by the active delegator
// onto a specific lane. `AtomIndex` is a 0-based counter assigned at dispatch
// time; `PromptPreview` is truncated server-side to at most 80 chars (see
// PROMPT_PREVIEW_MAX in src/router/progressEvents.ts).
type DelegatorAtomStartedEvent struct {
	Type          string `json:"type"`
	Seq           int64  `json:"seq"`
	SessionID     string `json:"sessionId"`
	AtomIndex     int    `json:"atomIndex"`
	LaneName      string `json:"laneName"`
	PromptPreview string `json:"promptPreview"`
	// 2026-05-24 patch — resolved provider/model for the lane.
	// Surfaced in debug-mode rendering as "<lane> · <provider>/<model>"
	// so users see exactly which model handled a given atom. Optional
	// for backwards-compat with old recorded sessions.
	LaneProvider string `json:"laneProvider,omitempty"`
	LaneModel    string `json:"laneModel,omitempty"`
}

// DelegatorAtomCompleteEvent marks an atom finishing — either successfully
// or with failure (interrupted, timed-out, etc.). `DurationMs` is the
// wall-time the atom took, measured by the scheduler.
type DelegatorAtomCompleteEvent struct {
	Type         string `json:"type"`
	Seq          int64  `json:"seq"`
	SessionID    string `json:"sessionId"`
	AtomIndex    int    `json:"atomIndex"`
	LaneName     string `json:"laneName"`
	Success      bool   `json:"success"`
	DurationMs   int    `json:"durationMs"`
	LaneProvider string `json:"laneProvider,omitempty"`
	LaneModel    string `json:"laneModel,omitempty"`
}

// DelegatorCompleteEvent marks the delegator turn finishing. `TotalAtomCount`
// is the number of atoms dispatched in this turn; `LaneDistribution` is a
// per-lane counter accumulated across the turn.
type DelegatorCompleteEvent struct {
	Type             string         `json:"type"`
	Seq              int64          `json:"seq"`
	SessionID        string         `json:"sessionId"`
	TotalAtomCount   int            `json:"totalAtomCount"`
	LaneDistribution map[string]int `json:"laneDistribution"`
}

// DecodeDelegatorPlan unmarshals the raw SSE payload into the typed shape.
func DecodeDelegatorPlan(raw []byte) (DelegatorPlanEvent, error) {
	var ev DelegatorPlanEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}

// DecodeDelegatorAtomStarted unmarshals the raw SSE payload into the typed shape.
func DecodeDelegatorAtomStarted(raw []byte) (DelegatorAtomStartedEvent, error) {
	var ev DelegatorAtomStartedEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}

// DecodeDelegatorAtomComplete unmarshals the raw SSE payload into the typed shape.
func DecodeDelegatorAtomComplete(raw []byte) (DelegatorAtomCompleteEvent, error) {
	var ev DelegatorAtomCompleteEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}

// DecodeDelegatorComplete unmarshals the raw SSE payload into the typed shape.
func DecodeDelegatorComplete(raw []byte) (DelegatorCompleteEvent, error) {
	var ev DelegatorCompleteEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}
