// Multi-agent workflows (2026-06-15) — Go decoders for the five workflow_*
// SSE events emitted by the workflow engine (src/workflows/events.ts) and
// published onto the per-session bus by the server-side /workflow run path.
//
// Mirrors src/workflows/events.ts (the `WorkflowEvent` union). The wire shapes
// (the engine's event fields PLUS the bus-added seq/sessionId envelope keys):
//
//	workflow_started        { type, [seq], [sessionId], workflow, phaseCount }
//	workflow_phase_started  { type, [seq], [sessionId], phaseId, index, taskCount }
//	workflow_task_started   { type, [seq], [sessionId], phaseId, index, label, lane? }
//	workflow_task_complete  { type, [seq], [sessionId], phaseId, index, label, ok }
//	workflow_complete        { type, [seq], [sessionId], workflow, ok, durationMs, phases }
//
// All five are publish-only — the engine emits them via its WorkflowEventSink;
// the server forwards them onto the bus and the TUI consumes them in app.go's
// SSE switch, rendering via components.FormatWorkflow*Line. seq/sessionId are
// optional here because the engine's event shape doesn't carry them; the bus
// adds them when it publishes (a central-integration seam, owner C).

package transport

import "encoding/json"

// WorkflowStartedEvent marks the start of a workflow run.
type WorkflowStartedEvent struct {
	Type       string `json:"type"`
	Seq        int64  `json:"seq"`
	SessionID  string `json:"sessionId"`
	Workflow   string `json:"workflow"`
	PhaseCount int    `json:"phaseCount"`
}

// WorkflowPhaseStartedEvent marks a phase beginning — a barrier point in the
// engine. `Index` is the 0-based phase position; `TaskCount` is the number of
// tasks dispatched in parallel for the phase.
type WorkflowPhaseStartedEvent struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	PhaseID   string `json:"phaseId"`
	Index     int    `json:"index"`
	TaskCount int    `json:"taskCount"`
}

// WorkflowTaskStartedEvent marks a single task dispatch within a phase.
// `Lane` is the optional cost-lane override; omitted when the task uses the
// agent's own role/provider resolution.
type WorkflowTaskStartedEvent struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	PhaseID   string `json:"phaseId"`
	Index     int    `json:"index"`
	Label     string `json:"label"`
	Lane      string `json:"lane,omitempty"`
}

// WorkflowTaskCompleteEvent marks a task finishing — `Ok` distinguishes a
// successful task from one whose child terminated with an error (the engine
// records the failure without aborting the phase).
type WorkflowTaskCompleteEvent struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	PhaseID   string `json:"phaseId"`
	Index     int    `json:"index"`
	Label     string `json:"label"`
	Ok        bool   `json:"ok"`
}

// WorkflowPhaseSummary is one phase's tallies in the closing summary.
type WorkflowPhaseSummary struct {
	PhaseID string `json:"phaseId"`
	Total   int    `json:"total"`
	Failed  int    `json:"failed"`
}

// WorkflowCompleteEvent marks the workflow run finishing. `Ok` is the overall
// success; `DurationMs` is the wall-time; `Phases` carries per-phase tallies.
type WorkflowCompleteEvent struct {
	Type       string                 `json:"type"`
	Seq        int64                  `json:"seq"`
	SessionID  string                 `json:"sessionId"`
	Workflow   string                 `json:"workflow"`
	Ok         bool                   `json:"ok"`
	DurationMs int                    `json:"durationMs"`
	Phases     []WorkflowPhaseSummary `json:"phases"`
}

// DecodeWorkflowStarted unmarshals the raw SSE payload into the typed shape.
func DecodeWorkflowStarted(raw []byte) (WorkflowStartedEvent, error) {
	var ev WorkflowStartedEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}

// DecodeWorkflowPhaseStarted unmarshals the raw SSE payload into the typed shape.
func DecodeWorkflowPhaseStarted(raw []byte) (WorkflowPhaseStartedEvent, error) {
	var ev WorkflowPhaseStartedEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}

// DecodeWorkflowTaskStarted unmarshals the raw SSE payload into the typed shape.
func DecodeWorkflowTaskStarted(raw []byte) (WorkflowTaskStartedEvent, error) {
	var ev WorkflowTaskStartedEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}

// DecodeWorkflowTaskComplete unmarshals the raw SSE payload into the typed shape.
func DecodeWorkflowTaskComplete(raw []byte) (WorkflowTaskCompleteEvent, error) {
	var ev WorkflowTaskCompleteEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}

// DecodeWorkflowComplete unmarshals the raw SSE payload into the typed shape.
func DecodeWorkflowComplete(raw []byte) (WorkflowCompleteEvent, error) {
	var ev WorkflowCompleteEvent
	err := json.Unmarshal(raw, &ev)
	return ev, err
}
