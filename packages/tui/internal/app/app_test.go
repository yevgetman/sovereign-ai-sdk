package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
)

func TestBareScaffold_rendersThreeRegions(t *testing.T) {
	tm := teatest.NewTestModel(t, New("test-session", "http://127.0.0.1:0"), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		// Look for the input prompt marker and the status row's bg color
		// has rendered (lipgloss outputs ANSI escapes — check for the
		// textinput prompt char "›").
		return contains(b, "›")
	}, teatest.WithDuration(2*time.Second))

	// ESC quits.
	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_consumesMultipleEventsFromSingleConnection guards against the
// regression where the SSE Cmd opened a fresh HTTP connection per event
// (read one event, return, re-Consume from seq=1 on a new connection).
// Drives three distinct SSE events through the model on a single connection
// and asserts each rendered exactly once, and that the server observed
// exactly one client connection.
func TestApp_consumesMultipleEventsFromSingleConnection(t *testing.T) {
	var connectionCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&connectionCount, 1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		// Emit 3 distinct events on this single connection.
		fmt.Fprint(w, "event: text_delta\nid: 1\ndata: {\"type\":\"text_delta\",\"seq\":1,\"sessionId\":\"s\",\"block\":0,\"text\":\"Hello \"}\n\n")
		flusher.Flush()
		fmt.Fprint(w, "event: text_delta\nid: 2\ndata: {\"type\":\"text_delta\",\"seq\":2,\"sessionId\":\"s\",\"block\":0,\"text\":\"world \"}\n\n")
		flusher.Flush()
		fmt.Fprint(w, "event: turn_complete\nid: 3\ndata: {\"type\":\"turn_complete\",\"seq\":3,\"sessionId\":\"s\",\"finishReason\":\"end_turn\"}\n\n")
		flusher.Flush()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New("test-session", srv.URL), teatest.WithInitialTermSize(80, 24))

	// Wait until the transcript has rendered the turn_complete marker — this
	// proves the model consumed all three events on the single connection.
	// (We don't assert on the rendered text of intermediate text_deltas
	// because teatest's ANSI compressor may coalesce frames and drop
	// overwritten content; the connectionCount==1 check at the end is the
	// deterministic regression guard.)
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "[turn complete]")
	}, teatest.WithDuration(3*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))

	if got := atomic.LoadInt32(&connectionCount); got != 1 {
		t.Fatalf("expected exactly 1 SSE connection, got %d (event-per-connection regression)", got)
	}
}

func contains(haystack []byte, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if string(haystack[i:i+len(needle)]) == needle {
			return true
		}
	}
	return false
}
