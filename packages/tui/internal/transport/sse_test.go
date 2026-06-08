package transport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConsume_streamsTextDeltaAndCompletes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, _ := w.(http.Flusher)

		fmt.Fprint(w, "event: text_delta\nid: 1\ndata: {\"type\":\"text_delta\",\"seq\":1,\"sessionId\":\"s\",\"block\":0,\"text\":\"Hi\"}\n\n")
		flusher.Flush()
		fmt.Fprint(w, "event: text_delta\nid: 2\ndata: {\"type\":\"text_delta\",\"seq\":2,\"sessionId\":\"s\",\"block\":0,\"text\":\" there\"}\n\n")
		flusher.Flush()
		fmt.Fprint(w, "event: turn_complete\nid: 3\ndata: {\"type\":\"turn_complete\",\"seq\":3,\"sessionId\":\"s\",\"finishReason\":\"end_turn\"}\n\n")
		flusher.Flush()
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	ch, errCh := Consume(ctx, srv.URL, 0)

	var got []Envelope
	for ev := range ch {
		got = append(got, ev)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("consume err: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d events, want 3", len(got))
	}
	if got[0].Type != "text_delta" || got[2].Type != "turn_complete" {
		t.Fatalf("types: %q ... %q", got[0].Type, got[2].Type)
	}
}

func TestConsume_sendsLastEventIDHeaderOnReconnect(t *testing.T) {
	// The reconnect cursor that fixes the infinite-replay loop: when lastEventID
	// > 0 we MUST send the standard `Last-Event-ID` header so the server replays
	// only events AFTER it (instead of re-delivering the whole completed turn on
	// every reconnect). On the first connect (0) the header must be absent so the
	// server treats it as a fresh subscriber (current-turn replay).
	headerCh := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headerCh <- r.Header.Get("Last-Event-ID")
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		fmt.Fprint(w, "event: turn_complete\nid: 7\ndata: {\"type\":\"turn_complete\",\"seq\":7,\"sessionId\":\"s\",\"finishReason\":\"end_turn\"}\n\n")
		flusher.Flush()
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Reconnect with a cursor → header present.
	ch, errCh := Consume(ctx, srv.URL, 42)
	for range ch { //nolint:revive // drain
	}
	<-errCh
	if h := <-headerCh; h != "42" {
		t.Fatalf("reconnect Last-Event-ID = %q, want \"42\"", h)
	}

	// Fresh connect (cursor 0) → header absent.
	ch2, errCh2 := Consume(ctx, srv.URL, 0)
	for range ch2 { //nolint:revive // drain
	}
	<-errCh2
	if h := <-headerCh; h != "" {
		t.Fatalf("fresh-connect Last-Event-ID = %q, want empty", h)
	}
}

func TestConsume_handlesLargeDataLine(t *testing.T) {
	// 2 MiB single-line payload — exceeds the old 1 MiB scanner cap, which used
	// to abort the stream ("token too long") and silently drop a large
	// tool_result. Must decode cleanly under the raised cap.
	big := strings.Repeat("x", 2*1024*1024)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		fmt.Fprintf(w, "event: tool_result\nid: 1\ndata: {\"type\":\"tool_result\",\"seq\":1,\"sessionId\":\"s\",\"text\":%q}\n\n", big)
		flusher.Flush()
		fmt.Fprint(w, "event: turn_complete\nid: 2\ndata: {\"type\":\"turn_complete\",\"seq\":2,\"sessionId\":\"s\",\"finishReason\":\"end_turn\"}\n\n")
		flusher.Flush()
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ch, errCh := Consume(ctx, srv.URL, 0)
	var got []Envelope
	for ev := range ch {
		got = append(got, ev)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("consume err: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d events, want 2 (the large line must not be dropped)", len(got))
	}
	if got[0].Type != "tool_result" {
		t.Fatalf("first event type = %q, want tool_result", got[0].Type)
	}
}
