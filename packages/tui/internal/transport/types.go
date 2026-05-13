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
