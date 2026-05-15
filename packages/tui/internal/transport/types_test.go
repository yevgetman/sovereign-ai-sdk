package transport

import (
	"encoding/json"
	"testing"
)

func TestDecodeTextDelta(t *testing.T) {
	raw := `{"type":"text_delta","seq":1,"sessionId":"s_t","block":0,"text":"hi"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("envelope decode: %v", err)
	}
	if env.Type != "text_delta" {
		t.Fatalf("got type=%q, want text_delta", env.Type)
	}
	if env.Seq != 1 {
		t.Fatalf("got seq=%d, want 1", env.Seq)
	}
	td, err := DecodeTextDelta(env.Raw)
	if err != nil {
		t.Fatalf("decode text_delta: %v", err)
	}
	if td.Text != "hi" {
		t.Fatalf("got text=%q, want %q", td.Text, "hi")
	}
}

func TestDecodeTurnComplete(t *testing.T) {
	raw := `{"type":"turn_complete","seq":42,"sessionId":"s","finishReason":"end_turn"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	tc, err := DecodeTurnComplete(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if tc.FinishReason != "end_turn" {
		t.Fatalf("got finishReason=%q", tc.FinishReason)
	}
}

func TestEnvelope_unknownType(t *testing.T) {
	raw := `{"type":"unknown_event","seq":1,"sessionId":"s"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "unknown_event" {
		t.Fatalf("got type=%q", env.Type)
	}
}

// TestDecodeCompactionComplete — M6 T6. Pins the wire-shape contract
// against src/server/schema.ts:100 (CompactionCompleteEvent). The
// `sessionId` carries the PARENT id and `activeSessionId` carries the
// new child id; a regression that swapped them or dropped one would
// leave the TUI POSTing onto the stale parent (silent break).
func TestDecodeCompactionComplete(t *testing.T) {
	raw := `{"type":"compaction_complete","seq":42,"sessionId":"parent-abc","activeSessionId":"child-xyz","summary":"summary text","estimatedBeforeTokens":1234,"estimatedAfterTokens":56}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("envelope decode: %v", err)
	}
	if env.Type != "compaction_complete" {
		t.Fatalf("got type=%q, want compaction_complete", env.Type)
	}
	cc, err := DecodeCompactionComplete(env.Raw)
	if err != nil {
		t.Fatalf("decode compaction_complete: %v", err)
	}
	if cc.SessionID != "parent-abc" {
		t.Fatalf("sessionID = %q, want parent-abc (parent)", cc.SessionID)
	}
	if cc.ActiveSessionID != "child-xyz" {
		t.Fatalf("activeSessionID = %q, want child-xyz (new child)", cc.ActiveSessionID)
	}
	if cc.Summary != "summary text" {
		t.Fatalf("summary = %q", cc.Summary)
	}
	if cc.EstimatedBeforeTokens != 1234 {
		t.Fatalf("estimatedBeforeTokens = %d, want 1234", cc.EstimatedBeforeTokens)
	}
	if cc.EstimatedAfterTokens != 56 {
		t.Fatalf("estimatedAfterTokens = %d, want 56", cc.EstimatedAfterTokens)
	}
}
