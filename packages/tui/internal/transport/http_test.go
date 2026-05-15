package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchMessages_DecodesBacklog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sessions/abc/messages" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"messages": []map[string]any{
				{
					"role": "user",
					"content": []map[string]any{
						{"type": "text", "text": "hello"},
					},
				},
				{
					"role": "assistant",
					"content": []map[string]any{
						{"type": "text", "text": "hi back"},
					},
				},
			},
		})
	}))
	defer srv.Close()

	msgs, err := FetchMessages(context.Background(), srv.URL, "abc")
	if err != nil {
		t.Fatalf("FetchMessages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("len(msgs) = %d, want 2", len(msgs))
	}
	if msgs[0].Role != "user" || len(msgs[0].Content) != 1 || msgs[0].Content[0].Text != "hello" {
		t.Fatalf("messages[0] mismatch: %+v", msgs[0])
	}
	if msgs[1].Role != "assistant" || msgs[1].Content[0].Text != "hi back" {
		t.Fatalf("messages[1] mismatch: %+v", msgs[1])
	}
}

func TestFetchMessages_HandlesNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := FetchMessages(context.Background(), srv.URL, "missing")
	if err == nil {
		t.Fatal("expected error on 404, got nil")
	}
}

// TestPostCompact_DecodesResponse — M6 T6. Pins the wire-shape contract
// against src/server/routes/compact.ts:70-77. A regression that drops
// activeSessionId or rearranges the JSON keys lands here as a decode
// failure or zero-value field rather than as a silently-broken pivot
// that ships to users.
func TestPostCompact_DecodesResponse(t *testing.T) {
	const sessionID = "parent-abc"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "wrong method", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != "/sessions/"+sessionID+"/compact" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"activeSessionId":       "child-xyz",
			"parentSessionId":       sessionID,
			"summary":               "Hello world.",
			"estimatedBeforeTokens": 1234,
			"estimatedAfterTokens":  56,
			"usedAuxiliary":         false,
		})
	}))
	defer srv.Close()

	resp, err := PostCompact(context.Background(), srv.URL, sessionID)
	if err != nil {
		t.Fatalf("PostCompact: %v", err)
	}
	if resp.ActiveSessionID != "child-xyz" {
		t.Fatalf("activeSessionId = %q, want child-xyz", resp.ActiveSessionID)
	}
	if resp.ParentSessionID != sessionID {
		t.Fatalf("parentSessionId = %q, want %q", resp.ParentSessionID, sessionID)
	}
	if resp.Summary != "Hello world." {
		t.Fatalf("summary = %q, want 'Hello world.'", resp.Summary)
	}
	if resp.EstimatedBeforeTokens != 1234 {
		t.Fatalf("estimatedBeforeTokens = %d, want 1234", resp.EstimatedBeforeTokens)
	}
	if resp.EstimatedAfterTokens != 56 {
		t.Fatalf("estimatedAfterTokens = %d, want 56", resp.EstimatedAfterTokens)
	}
	if resp.UsedAuxiliary {
		t.Fatalf("usedAuxiliary = true, want false")
	}
}

// TestPostCompact_HandlesError — M6 T6. The /compact route returns 500
// when the summarizer throws (covered by tests/server/compact.test.ts).
// The TUI surfaces this as a dim transcript line via compactErrorMsg —
// pin that the transport helper returns a non-nil error rather than
// swallowing the failure (which would leave the user wondering why
// nothing happened).
func TestPostCompact_HandlesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"mock failure"}`, http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := PostCompact(context.Background(), srv.URL, "parent-abc")
	if err == nil {
		t.Fatal("expected error on 500, got nil")
	}
}
