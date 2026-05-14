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
