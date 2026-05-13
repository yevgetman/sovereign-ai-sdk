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
