// Package transport mirrors src/server/schema.ts in Go.
// Stays in lockstep with the TS Zod schemas; reviewer must compare both sides
// when a schema changes.

package transport

import (
	"encoding/json"
	"fmt"
)

// Envelope is the on-wire shape: type + seq + sessionId + raw payload.
// The full message also contains type-specific fields; those are decoded
// into per-type structs via Decode<Type>(raw).
type Envelope struct {
	Type      string          `json:"type"`
	Seq       int64           `json:"seq"`
	SessionID string          `json:"sessionId"`
	Raw       json.RawMessage `json:"-"`
}

// UnmarshalJSON parses type/seq/sessionId AND keeps the full raw bytes for
// downstream type-specific decoding.
func (e *Envelope) UnmarshalJSON(data []byte) error {
	var head struct {
		Type      string `json:"type"`
		Seq       int64  `json:"seq"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return fmt.Errorf("envelope head: %w", err)
	}
	e.Type = head.Type
	e.Seq = head.Seq
	e.SessionID = head.SessionID
	e.Raw = append(e.Raw[:0], data...)
	return nil
}

type TextDelta struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	Block     int    `json:"block"`
	Text      string `json:"text"`
}

type ThinkingDelta struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	Block     int    `json:"block"`
	Text      string `json:"text"`
}

type ToolUseStart struct {
	Type         string          `json:"type"`
	Seq          int64           `json:"seq"`
	SessionID    string          `json:"sessionId"`
	Block        int             `json:"block"`
	Tool         string          `json:"tool"`
	InputPartial json.RawMessage `json:"inputPartial,omitempty"`
}

type ToolUseInputDelta struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	Block     int    `json:"block"`
	Delta     string `json:"delta"`
}

type ToolUseDone struct {
	Type      string          `json:"type"`
	Seq       int64           `json:"seq"`
	SessionID string          `json:"sessionId"`
	Block     int             `json:"block"`
	Input     json.RawMessage `json:"input"`
}

type ToolResult struct {
	Type       string          `json:"type"`
	Seq        int64           `json:"seq"`
	SessionID  string          `json:"sessionId"`
	Block      int             `json:"block"`
	Tool       string          `json:"tool"`
	Input      json.RawMessage `json:"input"`
	Output     json.RawMessage `json:"output"`
	RenderHint string          `json:"renderHint"`
	Language   string          `json:"language,omitempty"`
}

type PermissionRequest struct {
	Type      string          `json:"type"`
	Seq       int64           `json:"seq"`
	SessionID string          `json:"sessionId"`
	RequestID string          `json:"requestId"`
	Tool      string          `json:"tool"`
	Input     json.RawMessage `json:"input"`
	Reason    string          `json:"reason,omitempty"`
}

type StatusUpdate struct {
	Type         string  `json:"type"`
	Seq          int64   `json:"seq"`
	SessionID    string  `json:"sessionId"`
	Cost         float64 `json:"cost,omitempty"`
	TokensIn     int     `json:"tokensIn,omitempty"`
	TokensOut    int     `json:"tokensOut,omitempty"`
	CacheHitRate float64 `json:"cacheHitRate,omitempty"`
	Streaming    bool    `json:"streaming,omitempty"`
}

type TurnComplete struct {
	Type         string `json:"type"`
	Seq          int64  `json:"seq"`
	SessionID    string `json:"sessionId"`
	FinishReason string `json:"finishReason"`
}

type TurnError struct {
	Type        string `json:"type"`
	Seq         int64  `json:"seq"`
	SessionID   string `json:"sessionId"`
	Error       string `json:"error"`
	Recoverable bool   `json:"recoverable"`
}

type SessionResumed struct {
	Type           string `json:"type"`
	Seq            int64  `json:"seq"`
	SessionID      string `json:"sessionId"`
	ResumedFromSeq int64  `json:"resumedFromSeq"`
}

// CompactionComplete (M6 T6) is published by the proactive (T3) and
// overflow-recovery (T4) compaction paths when the session id hops to
// a new child. `SessionID` carries the PARENT id (the one the SSE
// subscriber connected to) and `ActiveSessionID` carries the new child
// id the rest of the turn pivots onto. The TUI must update its tracked
// session id to ActiveSessionID so subsequent POST /turns and approval
// requests route to the new session. Mirrors src/server/schema.ts:100
// (CompactionCompleteEvent).
type CompactionComplete struct {
	Type                  string `json:"type"`
	Seq                   int64  `json:"seq"`
	SessionID             string `json:"sessionId"`
	ActiveSessionID       string `json:"activeSessionId"`
	Summary               string `json:"summary"`
	EstimatedBeforeTokens int    `json:"estimatedBeforeTokens"`
	EstimatedAfterTokens  int    `json:"estimatedAfterTokens"`
}

func DecodeTextDelta(raw []byte) (TextDelta, error) {
	var t TextDelta
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeThinkingDelta(raw []byte) (ThinkingDelta, error) {
	var t ThinkingDelta
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeToolUseStart(raw []byte) (ToolUseStart, error) {
	var t ToolUseStart
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeToolUseInputDelta(raw []byte) (ToolUseInputDelta, error) {
	var t ToolUseInputDelta
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeToolUseDone(raw []byte) (ToolUseDone, error) {
	var t ToolUseDone
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeToolResult(raw []byte) (ToolResult, error) {
	var t ToolResult
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodePermissionRequest(raw []byte) (PermissionRequest, error) {
	var t PermissionRequest
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeStatusUpdate(raw []byte) (StatusUpdate, error) {
	var t StatusUpdate
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeTurnComplete(raw []byte) (TurnComplete, error) {
	var t TurnComplete
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeTurnError(raw []byte) (TurnError, error) {
	var t TurnError
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeSessionResumed(raw []byte) (SessionResumed, error) {
	var t SessionResumed
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeCompactionComplete(raw []byte) (CompactionComplete, error) {
	var t CompactionComplete
	err := json.Unmarshal(raw, &t)
	return t, err
}

// SessionSummary mirrors src/server/schema.ts's SessionSummaryEvent (M7 base
// shape + M8 T7 extension fields). Emitted by disposeSession when an attached
// bus is supplied. Extension fields (tokens, durations, tool counts) are
// pointer-or-zero-checked because M7-vintage emissions don't include them.
// Closes backlog #39 (Go mirror for SessionSummaryEvent).
type SessionSummary struct {
	Type            string         `json:"type"`
	Seq             int64          `json:"seq"`
	SessionID       string         `json:"sessionId"`
	TotalDispatched int            `json:"totalDispatched"`
	ByAgent         map[string]int `json:"byAgent"`
	Tokens          *SessionTokens `json:"tokens,omitempty"`
	StartedAtMs     *float64       `json:"startedAtMs,omitempty"`
	EndedAtMs       *float64       `json:"endedAtMs,omitempty"`
	AgentActiveMs   *float64       `json:"agentActiveMs,omitempty"`
	APITimeMs       *float64       `json:"apiTimeMs,omitempty"`
	ToolTimeMs      *float64       `json:"toolTimeMs,omitempty"`
	ToolCalls       *int           `json:"toolCalls,omitempty"`
	ToolOk          *int           `json:"toolOk,omitempty"`
	ToolErr         *int           `json:"toolErr,omitempty"`
}

// SessionTokens carries the per-session token usage rollup. EstimatedCostUsd
// is populated from recordTokenUsage in the M7 cost-fix; cache fields are
// optional because not every provider returns cache deltas.
type SessionTokens struct {
	Input            int     `json:"input"`
	Output           int     `json:"output"`
	CacheRead        *int    `json:"cacheRead,omitempty"`
	CacheWrite       *int    `json:"cacheWrite,omitempty"`
	EstimatedCostUsd float64 `json:"estimatedCostUsd"`
}

// DecodeSessionSummary unmarshals the raw SSE payload into the typed shape.
// M9 T7.
func DecodeSessionSummary(raw []byte) (SessionSummary, error) {
	var t SessionSummary
	err := json.Unmarshal(raw, &t)
	return t, err
}
