package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// newTestEnvelope builds a transport.Envelope for direct Update-driven
// tests. Used by the M9 T11 rewrites of the previously-skipped tests
// (rendersTurnErrorVisibly / showsThinkingIndicatorOnEnter /
// thinkingClearedByFirstResponseEvent) that bypass teatest's WaitFor
// polling race by injecting events directly.
func newTestEnvelope(eventType, sessionID string, seq int64, raw string) transport.Envelope {
	return transport.Envelope{
		Type:      eventType,
		Seq:       seq,
		SessionID: sessionID,
		Raw:       json.RawMessage(raw),
	}
}

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
// and asserts each rendered exactly once.
//
// Post-multi-turn-fix the model re-Consumes after each turn_complete to
// pick up the next turn's events (the production server disposes the bus
// per turn — see TestApp_reconsumesSSEAfterTurnComplete). So the steady
// state after a single turn is exactly 2 connections: the initial
// subscription + 1 reconnect after turn_complete. The first connection
// holds open via <-r.Context().Done() to PROVE all 3 events arrived on
// it (rather than racing against the reconnect). Anything > 2 means the
// reconnect fired more than once per turn — i.e. the original
// per-event-reconnect regression resurrected.
func TestApp_consumesMultipleEventsFromSingleConnection(t *testing.T) {
	var connectionCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// M4: route by path so the /messages hydration fetch and /events
		// SSE stream are independent. connectionCount tracks ONLY /events.
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		// M8 T6: skill cache hydration. Empty list keeps the slash
		// intercept inert (every leading slash falls through to normal
		// turn dispatch), which matches the pre-M8 behavior these tests
		// were written against.
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		n := atomic.AddInt32(&connectionCount, 1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		if n == 1 {
			// Emit 3 distinct events on this single connection.
			fmt.Fprint(w, "event: text_delta\nid: 1\ndata: {\"type\":\"text_delta\",\"seq\":1,\"sessionId\":\"s\",\"block\":0,\"text\":\"Hello \"}\n\n")
			flusher.Flush()
			fmt.Fprint(w, "event: text_delta\nid: 2\ndata: {\"type\":\"text_delta\",\"seq\":2,\"sessionId\":\"s\",\"block\":0,\"text\":\"world \"}\n\n")
			flusher.Flush()
			fmt.Fprint(w, "event: turn_complete\nid: 3\ndata: {\"type\":\"turn_complete\",\"seq\":3,\"sessionId\":\"s\",\"finishReason\":\"end_turn\"}\n\n")
			flusher.Flush()
			// Hold the connection open: this proves all 3 events
			// arrived on connection #1, rather than racing against
			// the reconnect after turn_complete.
			<-r.Context().Done()
			return
		}
		// Post-turn_complete reconnect lands here. Hold open until the
		// test client disconnects (ESC → ctx cancel → request cancels).
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New("test-session", srv.URL), teatest.WithInitialTermSize(80, 24))

	// Wait until the transcript has rendered the turn_complete marker — this
	// proves the model consumed all three events on the single connection.
	// (We don't assert on the rendered text of intermediate text_deltas
	// because teatest's ANSI compressor may coalesce frames and drop
	// overwritten content; the connectionCount<=2 check at the end is the
	// deterministic regression guard.)
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "turn complete")
	}, teatest.WithDuration(3*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))

	// Steady state after one turn: 1 initial + 1 post-turn_complete
	// reconnect = 2. >2 means a per-event reconnect regression.
	if got := atomic.LoadInt32(&connectionCount); got > 2 {
		t.Fatalf("expected at most 2 SSE connections (initial + 1 post-turn_complete reconnect), got %d (event-per-connection regression)", got)
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

// TestApp_enterSubmitsTurnViaPost guards M3.7: pressing ENTER on the prompt
// must POST the typed text to /sessions/<id>/turns. The events endpoint is
// kept open with no payload so the SSE consumer doesn't terminate the run.
func TestApp_enterSubmitsTurnViaPost(t *testing.T) {
	const sessionID = "test-session"

	var (
		mu           sync.Mutex
		capturedPath string
		capturedBody []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == fmt.Sprintf("/sessions/%s/turns", sessionID) {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			capturedPath = r.URL.Path
			capturedBody = body
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			return
		}
		// M4: serve the /messages backlog fetch with an empty list so the
		// fetchMessagesCmd resolves cleanly without blocking the events
		// endpoint or polluting the transcript.
		if r.URL.Path == fmt.Sprintf("/sessions/%s/messages", sessionID) {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		// M8 T6: serve an empty skills list so fetchSkillsCmd resolves
		// without blocking. The slash intercept stays inert because the
		// cache is empty.
		if r.URL.Path == fmt.Sprintf("/sessions/%s/skills", sessionID) {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		// events endpoint — keep the connection open with no payload until
		// the client disconnects, so the SSE consumer doesn't drive sseDone.
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		flusher.Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New(sessionID, srv.URL), teatest.WithInitialTermSize(80, 24))

	// Wait for initial render so the prompt is alive.
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "›")
	}, teatest.WithDuration(2*time.Second))

	// Type "hi" then ENTER.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	// Wait for the POST to land server-side.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := capturedPath
		mu.Unlock()
		if got != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	gotPath := capturedPath
	gotBody := capturedBody
	mu.Unlock()
	want := fmt.Sprintf("/sessions/%s/turns", sessionID)
	if gotPath != want {
		t.Fatalf("expected POST to %q, got %q", want, gotPath)
	}
	if !bytes.Contains(gotBody, []byte(`"hi"`)) {
		t.Fatalf("expected body to contain typed text, got %q", string(gotBody))
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_rendersTurnErrorVisibly guards the M3 smoke regression: any
// turn_error from the runtime (auth failure, rate limit, model rejection,
// transport hiccup) must visibly land in the transcript. The pre-fix
// handleEvent switch had no case for turn_error and silently dropped them,
// so the user saw nothing at all after ENTER.
//
// M9 T11: rewritten to drive Model.Update directly with a synthesized
// turn_error envelope, avoiding teatest's WaitFor polling race.
func TestApp_rendersTurnErrorVisibly(t *testing.T) {
	m := New("s-err", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	env := newTestEnvelope("turn_error", "s-err", 1,
		`{"type":"turn_error","seq":1,"sessionId":"s-err","error":"boom","recoverable":true}`)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	view := m.View()
	if !strings.Contains(view, "turn error") || !strings.Contains(view, "boom") {
		t.Errorf("turn_error not rendered visibly: %q", view)
	}
}

// TestApp_showsThinkingIndicatorOnEnter guards the M3 smoke regression's
// second prong: between ENTER and the first response event there must be
// visible feedback so a 1-3s real-provider round-trip doesn't look like a
// dead UI.
//
// M9 T11: rewritten to drive Model.Update directly with the ENTER keypress
// after a non-empty prompt, then assert the dim placeholder lands in the
// transcript. No teatest WaitFor needed.
func TestApp_showsThinkingIndicatorOnEnter(t *testing.T) {
	// baseURL must be non-empty for submitTurn to fire; point at a dead
	// localhost socket so the POST errors out cleanly without retries.
	m := New("s-think", "http://127.0.0.1:1")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	m = model.(Model)
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	view := m.View()
	if !strings.Contains(view, "thinking") {
		t.Errorf("thinking placeholder not rendered on ENTER: %q", view)
	}
}

// TestApp_thinkingClearedByFirstResponseEvent guards the placeholder removal
// path: when a text_delta arrives, the dim "…thinking" line should be popped
// before the delta text is appended. Otherwise the user sees "…thinking"
// stuck above every response.
//
// M9 T11: rewritten to drive Update directly: send ENTER to set the
// placeholder, then inject a text_delta sseMsg and assert the placeholder
// no longer appears in the rendered view.
func TestApp_thinkingClearedByFirstResponseEvent(t *testing.T) {
	m := New("s-clear", "http://127.0.0.1:1")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	m = model.(Model)
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	env := newTestEnvelope("text_delta", "s-clear", 1,
		`{"type":"text_delta","seq":1,"sessionId":"s-clear","block":0,"text":"response"}`)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	view := m.View()
	if strings.Contains(view, "thinking") {
		t.Errorf("thinking placeholder not cleared by text_delta: %q", view)
	}
	if !strings.Contains(view, "response") {
		t.Errorf("text_delta content missing: %q", view)
	}
}

// TestApp_renderToolResultAsCard guards M3.6: a tool_result event should
// produce a ToolCard with the tool name visible in the rendered transcript.
func TestApp_renderToolResultAsCard(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// M4: route /messages backlog fetch separately from the SSE stream.
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		// M8 T6: skill cache hydration. Empty list keeps the slash
		// intercept inert so existing assertions don't shift.
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		payload := strings.Join([]string{
			`event: tool_result`,
			`id: 1`,
			`data: {"type":"tool_result","seq":1,"sessionId":"s","block":0,"tool":"FileRead","input":{},"output":"","renderHint":"code"}`,
			``,
			``,
		}, "\n")
		fmt.Fprint(w, payload)
		flusher.Flush()
		// Keep the connection open until the client disconnects so the
		// stream doesn't close before the model renders.
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New("s", srv.URL), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "FileRead")
	}, teatest.WithDuration(3*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_compactSlashRoutesToCompactEndpoint guards M6 T6: typing
// `/compact` and pressing ENTER must intercept the input client-side
// and POST to /sessions/:id/compact rather than sending the literal
// string as a turn. After the response, m.sessionID must pivot to
// activeSessionId so subsequent turn POSTs hit the new child session.
//
// We can't observe m.sessionID directly through teatest (the Bubble Tea
// internals own the model copy after the first Update), so we verify
// the pivot transitively: type `/compact`, wait for the compact POST
// to land server-side, then type a normal message and assert THAT POST
// hits /sessions/<NEW-CHILD>/turns rather than the original parent.
func TestApp_compactSlashRoutesToCompactEndpoint(t *testing.T) {
	const parentID = "parent-session"
	const childID = "child-session"

	var (
		mu             sync.Mutex
		compactPosts   []string
		turnPostsPath  []string
		turnPostsBody  [][]byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Compact route — return the new child session id.
		if r.Method == http.MethodPost && r.URL.Path == "/sessions/"+parentID+"/compact" {
			mu.Lock()
			compactPosts = append(compactPosts, r.URL.Path)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"activeSessionId":       childID,
				"parentSessionId":       parentID,
				"summary":               "Hello world.",
				"estimatedBeforeTokens": 100,
				"estimatedAfterTokens":  20,
				"usedAuxiliary":         false,
			})
			return
		}
		// Turn POST — capture path so we can assert the post-compact
		// turn hits the CHILD session id.
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/turns") {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			turnPostsPath = append(turnPostsPath, r.URL.Path)
			turnPostsBody = append(turnPostsBody, body)
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			return
		}
		// Messages backlog — empty so hydration resolves cleanly.
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		// M8 T6: skill cache hydration — empty list keeps the slash
		// intercept inert across this test.
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		// Events stream — keep open so the SSE consumer doesn't drive
		// sseDone before assertions land.
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		flusher.Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New(parentID, srv.URL), teatest.WithInitialTermSize(80, 24))

	// Wait for initial render so the prompt is alive.
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "›")
	}, teatest.WithDuration(2*time.Second))

	// Type "/compact" then ENTER.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/compact")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	// Wait for the compact POST to land server-side.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := len(compactPosts)
		mu.Unlock()
		if got > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	gotCompactPosts := append([]string(nil), compactPosts...)
	mu.Unlock()
	if len(gotCompactPosts) != 1 {
		t.Fatalf("expected 1 POST to /compact, got %d", len(gotCompactPosts))
	}

	// Wait for the transcript marker to confirm the model processed the
	// compactCompleteMsg (m.sessionID is now child id internally).
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "compacted") && contains(b, childID[:8])
	}, teatest.WithDuration(3*time.Second))

	// Now type a regular turn — it MUST POST to /sessions/<CHILD>/turns,
	// proving m.sessionID was pivoted.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(turnPostsPath)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	gotTurnPaths := append([]string(nil), turnPostsPath...)
	gotTurnBodies := append([][]byte(nil), turnPostsBody...)
	mu.Unlock()
	if len(gotTurnPaths) != 1 {
		t.Fatalf("expected 1 POST to /turns after compact, got %d", len(gotTurnPaths))
	}
	wantPath := "/sessions/" + childID + "/turns"
	if gotTurnPaths[0] != wantPath {
		t.Fatalf("post-compact /turns path = %q, want %q (session id did not pivot)",
			gotTurnPaths[0], wantPath)
	}
	if !bytes.Contains(gotTurnBodies[0], []byte(`"hi"`)) {
		t.Fatalf("post-compact /turns body = %q, want to contain 'hi'", string(gotTurnBodies[0]))
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_compactionCompleteSSEPivotsSession guards M6 T6: when the
// proactive (T3) or overflow-recovery (T4) paths emit a
// compaction_complete SSE event, the TUI must update m.sessionID to
// activeSessionId so subsequent turn POSTs hit the new child.
//
// We can't observe m.sessionID directly through teatest (the Bubble Tea
// internals own the model copy), so we verify the pivot end-to-end:
// the events handler emits the SSE event, the test polls for a turn
// POST until it lands, and asserts THAT POST hit the CHILD session id
// rather than the parent. The events handler holds the connection so
// the SSE consumer doesn't drive sseDone before the assertion.
func TestApp_compactionCompleteSSEPivotsSession(t *testing.T) {
	const parentID = "parent-session"
	const childID = "child-session"

	var (
		mu               sync.Mutex
		turnPostsPath    []string
		eventsServedOnce sync.Once
		eventsServedCh   = make(chan struct{})
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/turns") {
			mu.Lock()
			turnPostsPath = append(turnPostsPath, r.URL.Path)
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		// M8 T6: skill cache hydration — empty list keeps the slash
		// intercept inert across this test.
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		// Events stream — emit a single compaction_complete then hold
		// the connection so the consumer doesn't drive sseDone before
		// the test sends the follow-up turn. Signal eventsServedCh
		// once flushed so the test can drive the next ENTER without
		// a brittle sleep.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		payload := fmt.Sprintf("event: compaction_complete\nid: 1\ndata: {\"type\":\"compaction_complete\",\"seq\":1,\"sessionId\":\"%s\",\"activeSessionId\":\"%s\",\"summary\":\"auto\",\"estimatedBeforeTokens\":1000,\"estimatedAfterTokens\":50}\n\n", parentID, childID)
		fmt.Fprint(w, payload)
		flusher.Flush()
		eventsServedOnce.Do(func() { close(eventsServedCh) })
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New(parentID, srv.URL), teatest.WithInitialTermSize(80, 24))

	// Wait until the events handler has flushed the compaction_complete
	// payload. The SSE consumer reads the bytes off the wire, the
	// envelope decodes, and Update calls handleEvent("compaction_complete")
	// which assigns m.sessionID = childID. There's no direct observable
	// for the assignment from teatest (the renderer's framebuffer can
	// lag the model state), so we wait for the wire-level signal then
	// give the model goroutine a brief settle window before driving
	// the follow-up keys.
	select {
	case <-eventsServedCh:
	case <-time.After(3 * time.Second):
		t.Fatal("events handler never served the compaction_complete payload")
	}
	// Brief settle so the SSE consumer reads + parses + the Update
	// goroutine processes the sseMsg before we send the ENTER. 200ms
	// matches the existing tests' poll cadence.
	time.Sleep(200 * time.Millisecond)

	// Send a turn — it MUST POST to the CHILD session id.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(turnPostsPath)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	gotTurnPaths := append([]string(nil), turnPostsPath...)
	mu.Unlock()
	if len(gotTurnPaths) != 1 {
		t.Fatalf("expected 1 POST to /turns after compaction_complete, got %d (paths=%v)",
			len(gotTurnPaths), gotTurnPaths)
	}
	wantPath := "/sessions/" + childID + "/turns"
	if gotTurnPaths[0] != wantPath {
		t.Fatalf("post-SSE /turns path = %q, want %q (compaction_complete didn't pivot session id)",
			gotTurnPaths[0], wantPath)
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_compactSlashHandlesNoOp guards backlog #36's TUI surface: when
// the server returns a no-op compact response (entire history fit within
// the tail budget — activeSessionId === parentSessionId, noOp: true),
// the TUI must:
//
//  1. NOT render the misleading "─ compacted — new session <prefix>"
//     marker (the prefix would be the SAME id the user already had).
//  2. Render the "─ nothing to compact (history already fits)" marker
//     instead so the user understands the call succeeded but no
//     compaction took place.
//  3. NOT pivot m.sessionID — subsequent turn POSTs must continue to
//     hit the parent session id, not a phantom child.
//
// Pre-fix (M6 baseline) the TUI rendered the "new session" marker
// unconditionally, which combined with the server's misleading
// "estimatedAfterTokens > estimatedBeforeTokens" output produced the
// "auto-compacted — 2247→2318 tokens — new session abcd1234" cosmetic
// bug the backlog item was filed against.
func TestApp_compactSlashHandlesNoOp(t *testing.T) {
	const parentID = "parent-session"

	var (
		mu            sync.Mutex
		compactPosts  []string
		turnPostsPath []string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Compact route — return the no-op shape: activeSessionId echoes
		// the input parent id, noOp=true.
		if r.Method == http.MethodPost && r.URL.Path == "/sessions/"+parentID+"/compact" {
			mu.Lock()
			compactPosts = append(compactPosts, r.URL.Path)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"activeSessionId":       parentID,
				"parentSessionId":       parentID,
				"summary":               "",
				"estimatedBeforeTokens": 2247,
				"estimatedAfterTokens":  2247,
				"usedAuxiliary":         false,
				"noOp":                  true,
			})
			return
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/turns") {
			mu.Lock()
			turnPostsPath = append(turnPostsPath, r.URL.Path)
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		// M8 T6: skill cache hydration — empty list keeps the slash
		// intercept inert across this test.
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		flusher.Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New(parentID, srv.URL), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "›")
	}, teatest.WithDuration(2*time.Second))

	// Type "/compact" then ENTER — same client-side intercept as the
	// happy-path test, but the server returns a no-op response.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/compact")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(compactPosts)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	gotCompactPosts := append([]string(nil), compactPosts...)
	mu.Unlock()
	if len(gotCompactPosts) != 1 {
		t.Fatalf("expected 1 POST to /compact, got %d", len(gotCompactPosts))
	}

	// The friendlier no-op marker must surface AND the misleading
	// "new session" marker must be ABSENT.
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "nothing to compact")
	}, teatest.WithDuration(3*time.Second))

	// Type a normal message — the POST MUST hit the PARENT session id,
	// proving m.sessionID was not pivoted.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(turnPostsPath)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	gotTurnPaths := append([]string(nil), turnPostsPath...)
	mu.Unlock()
	if len(gotTurnPaths) != 1 {
		t.Fatalf("expected 1 POST to /turns after no-op compact, got %d", len(gotTurnPaths))
	}
	wantPath := "/sessions/" + parentID + "/turns"
	if gotTurnPaths[0] != wantPath {
		t.Fatalf("post-noOp /turns path = %q, want %q (m.sessionID was pivoted on a no-op response)",
			gotTurnPaths[0], wantPath)
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_reconsumesSSEAfterTurnComplete pins the multi-turn contract:
// after the server closes the SSE stream on turn_complete (events.ts:63-74
// dispose the bus by design), the TUI must re-Consume a fresh subscription
// so subsequent turns within the same TUI launch deliver their events to
// the user. Pre-fix the TUI subscribed once in New() and never reconnected,
// so all turns after the first delivered 202 from POST /turns but their
// SSE events were silently dropped.
//
// Drives two consecutive turns through teatest:
//  1. Initial SSE handler invocation streams turn 1 events + turn_complete
//     and then returns (server closes the stream).
//  2. After the first turn_complete renders, type a second message and
//     ENTER. The /turns POST must land, the SSE handler must be invoked
//     a SECOND time on a fresh connection, and turn 2's events must
//     render in the transcript.
func TestApp_reconsumesSSEAfterTurnComplete(t *testing.T) {
	const sessionID = "test-session"
	var (
		sseConnCount   int32
		turnPostsCount int32
		turn1Done      = make(chan struct{})
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /turns — accept POSTs and count them so we can correlate
		// turn-N body with the SSE stream for that turn.
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/turns") {
			atomic.AddInt32(&turnPostsCount, 1)
			w.WriteHeader(http.StatusAccepted)
			return
		}
		// /messages backlog — empty so hydration resolves cleanly.
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		// M8 T6: skill cache hydration — empty list keeps the slash
		// intercept inert across this test.
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		// /events SSE — branch on connection count. First connection
		// streams turn 1 events + turn_complete and returns (closing
		// the response body, simulating the production server's
		// disposeBus on turn_complete). Second connection streams turn
		// 2 events + turn_complete.
		n := atomic.AddInt32(&sseConnCount, 1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		switch n {
		case 1:
			// Turn 1: emit a text_delta then turn_complete and return.
			fmt.Fprint(w, "event: text_delta\nid: 1\ndata: {\"type\":\"text_delta\",\"seq\":1,\"sessionId\":\"test-session\",\"block\":0,\"text\":\"TURN_ONE_REPLY\"}\n\n")
			flusher.Flush()
			fmt.Fprint(w, "event: turn_complete\nid: 2\ndata: {\"type\":\"turn_complete\",\"seq\":2,\"sessionId\":\"test-session\",\"finishReason\":\"end_turn\"}\n\n")
			flusher.Flush()
			close(turn1Done)
			// Returning closes the response body, which is exactly
			// what the production server does after disposeBus.
			return
		case 2:
			// Turn 2: emit a distinct text_delta then turn_complete.
			fmt.Fprint(w, "event: text_delta\nid: 1\ndata: {\"type\":\"text_delta\",\"seq\":1,\"sessionId\":\"test-session\",\"block\":0,\"text\":\"TURN_TWO_REPLY\"}\n\n")
			flusher.Flush()
			fmt.Fprint(w, "event: turn_complete\nid: 2\ndata: {\"type\":\"turn_complete\",\"seq\":2,\"sessionId\":\"test-session\",\"finishReason\":\"end_turn\"}\n\n")
			flusher.Flush()
			return
		default:
			// After turn 2's turn_complete the TUI re-Consumes again
			// (its design — every turn_complete reconnects so the
			// NEXT user turn lands on a live subscription). Hold this
			// idle connection until the client disconnects (ESC/quit).
			// The request context cancels when the test client closes,
			// so srv.Close() doesn't block.
			<-r.Context().Done()
			return
		}
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New(sessionID, srv.URL), teatest.WithInitialTermSize(80, 24))

	// Wait for the server to confirm turn 1's SSE handler returned (so
	// the consumer side has observed EOF and the model has processed
	// sseDoneMsg). We don't sleep on a hard duration — we wait for the
	// wire signal then give the Update goroutine a brief settle window
	// to process the channel close into sseDoneMsg + reconnect. (We
	// don't WaitFor "TURN_ONE_REPLY" in the rendered output because
	// teatest's ANSI compressor may drop intermediate text_deltas; the
	// SAME pre-existing limitation is documented at
	// TestApp_consumesMultipleEventsFromSingleConnection. The server-
	// side wire signal is the deterministic substitute.)
	select {
	case <-turn1Done:
	case <-time.After(3 * time.Second):
		t.Fatal("turn 1 SSE handler never finished serving")
	}
	time.Sleep(300 * time.Millisecond)

	// Now drive turn 2.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi2")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	// Wait for the second /turns POST to land server-side.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&turnPostsCount) >= 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&turnPostsCount); got < 1 {
		t.Fatalf("expected at least 1 POST to /turns, got %d", got)
	}

	// The fix's load-bearing assertion: turn 2's SSE events must arrive
	// at the model and render in the transcript. Pre-fix this WaitFor
	// times out because the SSE consumer was closed after turn 1 and
	// no fresh subscription was opened, so turn 2's POST returns 202
	// but its events are silently dropped.
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "TURN_TWO_REPLY")
	}, teatest.WithDuration(3*time.Second))

	// Pin the connect cadence: at least 2 SSE connections, and at most 3.
	// One per turn_complete reconnect: initial subscription + reconnect
	// after turn 1's turn_complete + reconnect after turn 2's turn_complete
	// = 3 in steady state. The minimum is 2 (one connection per turn
	// observed). >3 would indicate a tight reconnect loop bug — for example
	// re-Consuming inside a loop on every event rather than every turn end.
	got := atomic.LoadInt32(&sseConnCount)
	if got < 2 || got > 3 {
		t.Fatalf("expected 2 or 3 SSE connections, got %d (>3 = tight reconnect loop bug)", got)
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_hydratesTranscriptFromPriorMessages guards M4 Task 9: on Init the
// app fetches GET /sessions/<id>/messages and renders each prior text block
// before (or alongside) the live SSE stream. Resume flows therefore show the
// full prior conversation immediately.
func TestApp_hydratesTranscriptFromPriorMessages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sessions/test-session/messages":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"messages": []map[string]any{
					{"role": "user", "content": []map[string]any{{"type": "text", "text": "old user msg"}}},
					{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "old asst msg"}}},
				},
			})
		case "/sessions/test-session/events":
			// SSE stream that emits a single turn_complete and then holds the
			// connection open so the consumer doesn't drive sseDone before
			// the assertions land.
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, ok := w.(http.Flusher)
			if !ok {
				return
			}
			fmt.Fprint(w, "event: turn_complete\nid: 0\ndata: {\"type\":\"turn_complete\",\"seq\":0,\"sessionId\":\"test-session\",\"finishReason\":\"end_turn\"}\n\n")
			flusher.Flush()
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New("test-session", srv.URL), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return bytes.Contains(b, []byte("old user msg")) &&
			bytes.Contains(b, []byte("old asst msg"))
	}, teatest.WithDuration(3*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// M9.5 T3 — theme persistence tests. Each uses t.TempDir() + t.Setenv to
// isolate the harness home from the developer's real config.

func TestApp_BootReadsConfigTheme(t *testing.T) {
	tmpHome := t.TempDir()
	configPath := filepath.Join(tmpHome, "config.json")
	if err := os.WriteFile(configPath, []byte(`{"theme":"tokyo-night"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-cfg", "")
	if m.theme.Name != "tokyo-night" {
		t.Errorf("boot theme: got %q want tokyo-night", m.theme.Name)
	}
}

func TestApp_BootMissingConfigDefaultsToDark(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-nocfg", "")
	if m.theme.Name != "dark" {
		t.Errorf("missing config: got %q want dark", m.theme.Name)
	}
}

func TestApp_BootSovereignTheme(t *testing.T) {
	tmpHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpHome, "config.json"), []byte(`{"theme":"sovereign"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-sov", "")
	if m.theme.Name != "sovereign" {
		t.Errorf("sovereign boot: got %q want sovereign", m.theme.Name)
	}
}

func TestApp_BootLoadsTomlTheme(t *testing.T) {
	tmpHome := t.TempDir()
	themesDirPath := filepath.Join(tmpHome, "themes")
	if err := os.MkdirAll(themesDirPath, 0o755); err != nil {
		t.Fatal(err)
	}
	tomlContent := `name = "neon"

[colors]
primary = "#ff00ff"
`
	if err := os.WriteFile(filepath.Join(themesDirPath, "neon.toml"), []byte(tomlContent), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpHome, "config.json"), []byte(`{"theme":"neon"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-toml", "")
	if m.theme.Name != "neon" {
		t.Errorf("toml theme: got %q want neon", m.theme.Name)
	}
	if string(m.theme.Primary) != "#ff00ff" {
		t.Errorf("toml primary not applied: %q", m.theme.Primary)
	}
}

func TestApp_BootUnknownThemeFallsBackToDarkWithError(t *testing.T) {
	tmpHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpHome, "config.json"), []byte(`{"theme":"made-up-3000"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-unk", "")
	if m.theme.Name != "dark" {
		t.Errorf("unknown theme: got %q want dark fallback", m.theme.Name)
	}
	if m.pendingThemeErr == nil {
		t.Error("pendingThemeErr should be set for unknown theme")
	}
}

func TestApp_ThemeSwitchWritesConfig(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-write", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	for _, r := range "/theme light" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)

	data, err := os.ReadFile(filepath.Join(tmpHome, "config.json"))
	if err != nil {
		t.Fatalf("config.json not written: %v", err)
	}
	if !strings.Contains(string(data), `"theme"`) || !strings.Contains(string(data), "light") {
		t.Errorf("config.json missing theme:light — %q", string(data))
	}
}

func TestApp_ThemeSwitchPreservesOtherConfigFields(t *testing.T) {
	tmpHome := t.TempDir()
	// Pre-write a config with unrelated fields.
	if err := os.WriteFile(filepath.Join(tmpHome, "config.json"), []byte(`{"theme":"dark","provider":"anthropic","other_field":42}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HARNESS_HOME", tmpHome)

	m := New("s-preserve", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	for _, r := range "/theme sovereign" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)

	data, err := os.ReadFile(filepath.Join(tmpHome, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	body := string(data)
	if !strings.Contains(body, "sovereign") {
		t.Errorf("theme not updated to sovereign: %q", body)
	}
	if !strings.Contains(body, "anthropic") {
		t.Errorf("provider field not preserved: %q", body)
	}
	if !strings.Contains(body, "other_field") {
		t.Errorf("other_field not preserved: %q", body)
	}
}

// M9.6 T1 — mouse click handling tests.

func TestApp_ClickOnToolCardTogglesExpanded(t *testing.T) {
	m := New("s-click", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"tool_result","seq":1,"sessionId":"s-click","block":0,"tool":"Bash","input":{"command":"ls"},"output":"file-list-content","renderHint":"text"}`
	env := newTestEnvelope("tool_result", "s-click", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	beforeClick := m.View()
	// Click at Y=0 (where the tool card was rendered).
	model, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, Y: 0})
	m = model.(Model)
	afterClick := m.View()
	// One of them should contain the output text — the other should not.
	hadBefore := strings.Contains(beforeClick, "file-list-content")
	hadAfter := strings.Contains(afterClick, "file-list-content")
	if hadBefore == hadAfter {
		t.Errorf("toolcard Expanded state should toggle on click — before:%v after:%v\nbefore:%q\nafter:%q", hadBefore, hadAfter, beforeClick, afterClick)
	}
}

func TestApp_ClickOnPromptIsNoOp(t *testing.T) {
	m := New("s-prompt", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Y near the prompt (height 24 - status 1 - prompt 2 = 21, so prompt rows are Y=21-22).
	model, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, Y: 22})
	_ = model.(Model)
	// No panic; no model state change relevant.
}

func TestApp_WheelEventStillScrolls(t *testing.T) {
	m := New("s-wheel", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Wheel events must still forward to the transcript (M9 T9 behavior).
	model, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonWheelUp, Y: 0})
	_ = model.(Model)
	// No panic. Scroll state is bubbles-internal; we only check we didn't
	// route this through handleMouseClick.
}

// M9.6 T2 — stall badge tests.

func TestApp_StallDetectedShowsBadge(t *testing.T) {
	m := New("s-stall", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"stall_detected","seq":1,"sessionId":"s-stall","reason":"no edits","turn":3}`
	env := newTestEnvelope("stall_detected", "s-stall", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	if m.stallBadge == nil {
		t.Fatal("stallBadge should be populated")
	}
	if m.stallBadge.Reason != "no edits" {
		t.Errorf("reason: got %q", m.stallBadge.Reason)
	}
	view := m.View()
	if !strings.Contains(view, "stalled") {
		t.Errorf("view missing 'stalled': %q", view)
	}
}

func TestApp_StallExpireMatchingGenClearsBadge(t *testing.T) {
	m := New("s-exp", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"stall_detected","seq":1,"sessionId":"s-exp","reason":"x","turn":1}`
	env := newTestEnvelope("stall_detected", "s-exp", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	if m.stallBadge == nil {
		t.Fatal("badge should be visible after stall_detected")
	}
	gen := m.stallGeneration
	model, _ = m.Update(stallExpireMsg{gen: gen})
	m = model.(Model)
	if m.stallBadge != nil {
		t.Error("badge should be cleared on matching-gen expire")
	}
}

func TestApp_StallExpireStaleGenIgnored(t *testing.T) {
	m := New("s-stale", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw1 := `{"type":"stall_detected","seq":1,"sessionId":"s-stale","reason":"a","turn":1}`
	env1 := newTestEnvelope("stall_detected", "s-stale", 1, raw1)
	model, _ = m.Update(sseMsg{env: env1})
	m = model.(Model)
	firstGen := m.stallGeneration
	// Second stall arrives (new gen).
	raw2 := `{"type":"stall_detected","seq":2,"sessionId":"s-stale","reason":"b","turn":2}`
	env2 := newTestEnvelope("stall_detected", "s-stale", 2, raw2)
	model, _ = m.Update(sseMsg{env: env2})
	m = model.(Model)
	// First tick's expire fires with the now-stale gen.
	model, _ = m.Update(stallExpireMsg{gen: firstGen})
	m = model.(Model)
	if m.stallBadge == nil {
		t.Error("stale-gen expire should NOT clear an extended badge")
	}
	if m.stallBadge.Reason != "b" {
		t.Errorf("badge should hold latest reason: got %q", m.stallBadge.Reason)
	}
}
