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

// ux-fixes round 5 — the round-4 PgUp / Shift+arrow scroll bindings
// are gone. The terminal owns scrollback natively now that alt screen
// is disabled. No client-side scroll wiring to test.

// scrollbackContent is a test helper that joins every line ever
// drained via tea.Println into a single string. Direct-Update tests
// use this instead of View() because committed history (user msgs,
// system msgs, finalized assistant cards, etc.) no longer appears in
// View() — it flows into the terminal's scrollback via tea.Println.
// Inspects emittedPrintln (the drained-snapshot slice on Model) so the
// helper works even after Update has drained pendingPrintln.
// ux-fixes round 5.
func scrollbackContent(m Model) string {
	return strings.Join(m.emittedPrintln, "\n")
}

// TestPrintUser_WrapsLongMessage covers the ux-fixes-round-5 contract
// that user submissions render across multiple lines at the terminal
// width, not as a single horizontally-overflowing line. Drives a long
// message through Update via the slash-skill-fallthrough path.
func TestPrintUser_WrapsLongMessage(t *testing.T) {
	m := New("s-wrap", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 40, Height: 24})
	m = model.(Model)
	// Submit a message ~200 chars long.
	long := strings.Repeat("alpha beta ", 20) // 220 chars
	for _, r := range long {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	out := scrollbackContent(m)
	// The user-line should appear, wrapped across multiple rows. Pin
	// the marker presence + that the rendered text spans more than one
	// line (newlines in the queued user-line).
	if !strings.Contains(out, "alpha") {
		t.Fatalf("expected user message in scrollback; got %q", out)
	}
	lines := strings.Split(out, "\n")
	userLineCount := 0
	for _, ln := range lines {
		if strings.Contains(ln, "alpha") {
			userLineCount++
		}
	}
	if userLineCount < 2 {
		t.Errorf("expected user message wrapped to >= 2 lines at width 40; got %d lines:\n%s", userLineCount, out)
	}
}

// TestPrintUser_TruncatesExtremelyLongMessage covers the 1500-char cap.
// Anything past userMessageDisplayCap is replaced by a "[+N chars]"
// marker so a giant paste doesn't dominate scrollback.
func TestPrintUser_TruncatesExtremelyLongMessage(t *testing.T) {
	m := New("s-trunc", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	m.pendingPrintln = nil
	m.emittedPrintln = nil
	// Directly call printUser with > userMessageDisplayCap chars.
	huge := strings.Repeat("x", userMessageDisplayCap+500)
	m.printUser(huge)
	m.drainPrintln()
	out := scrollbackContent(m)
	if !strings.Contains(out, "[+500 chars]") {
		t.Errorf("expected truncation marker; got %q", out)
	}
	// Pre-truncation chars should still be present; post-truncation chars
	// (anywhere past the cap) must NOT be in the rendered output beyond
	// what fits in the kept-window + marker.
	if strings.Count(out, "x") < userMessageDisplayCap-50 {
		t.Errorf("kept window too small; got %d x chars", strings.Count(out, "x"))
	}
}

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
		// Look for the input prompt marker (style.S.Prompt.Marker).
		return contains(b, "▸")
	}, teatest.WithDuration(2*time.Second))

	// ESC quits.
	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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
		// Backlog #45 — GET /commands hydration. Empty list keeps the
		// autocomplete popup driven by the compile-time staticEntries.
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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

	// Wait until the transcript has rendered the turn separator — this
	// proves the model consumed all three events on the single connection.
	// M11.7 replaced "turn complete" text with a pure horizontal rule
	// (turnSeparator) so we look for the box-drawing character instead.
	// (We don't assert on the rendered text of intermediate text_deltas
	// because teatest's ANSI compressor may coalesce frames and drop
	// overwritten content; the connectionCount<=2 check at the end is the
	// deterministic regression guard.)
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "────────")
	}, teatest.WithDuration(3*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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
		return contains(b, "▸")
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

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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
	// ux-fixes round 5 — turn_error output is no longer rendered into
	// the live View(); it's queued via m.print and emitted via
	// tea.Println into the terminal's scrollback. Drive handleEvent
	// directly so pendingPrintln stays populated (Update's sseMsg
	// branch drains it via m.respond; we want to inspect the queued
	// content here).
	m := New("s-err", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Clear the splash + boot notices queue so the assertion below
	// inspects only the turn_error output.
	m.pendingPrintln = nil
	env := newTestEnvelope("turn_error", "s-err", 1,
		`{"type":"turn_error","seq":1,"sessionId":"s-err","error":"boom","recoverable":true}`)
	_ = m.handleEvent(env)
	joined := strings.Join(m.pendingPrintln, "\n")
	if !strings.Contains(joined, "turn error") || !strings.Contains(joined, "boom") {
		t.Errorf("turn_error not queued for scrollback emission: %q", joined)
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
	// ux-fixes round 2: spinner label is now capitalized "Thinking..."
	// with an animated ellipsis. The presence of "Thinking" in the
	// view proves the spinner is rendered (the dot count is animation-
	// dependent and not relied on here).
	if !strings.Contains(view, "Thinking") {
		t.Errorf("Thinking spinner not rendered on ENTER: %q", view)
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
// render visibly in the rendered transcript.
//
// ux-fixes 2026-05-22: default tool-output mode flipped to 'compact'
// (one-liner per tool_result via components.FormatCompactToolLine).
// The FileRead tool now renders as "Read <path> ›" — verb-first, not
// tool-name-first. Test assertion updated accordingly; the detailed
// mode is exercised by TestApp_renderToolResultInDetailedMode below.
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
		// Backlog #45 — GET /commands hydration. Empty list keeps the
		// autocomplete popup driven by the compile-time staticEntries.
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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
			`data: {"type":"tool_result","seq":1,"sessionId":"s","block":0,"tool":"FileRead","input":{"path":"foo.go"},"output":"","renderHint":"code"}`,
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
		// Compact mode default — assert verb + target appear on a
		// single line. The "Read" verb is FormatCompactToolLine's
		// mapping for FileRead.
		return contains(b, "Read") && contains(b, "foo.go")
	}, teatest.WithDuration(3*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_renderToolResultInDetailedMode guards the opt-in detailed
// mode: when ui.toolOutput.mode is set to 'detailed' via WithToolOutput,
// tool_result events render as the existing bordered ToolCard with the
// tool name in the header. Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
func TestApp_renderToolResultInDetailedMode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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
			`data: {"type":"tool_result","seq":1,"sessionId":"s","block":0,"tool":"FileRead","input":{"path":"foo.go"},"output":"line 1\nline 2","renderHint":"code"}`,
			``,
			``,
		}, "\n")
		fmt.Fprint(w, payload)
		flusher.Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	m := New("s", srv.URL).WithToolOutput("detailed", 10)
	tm := teatest.NewTestModel(t, m, teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		// Detailed mode — bordered card with tool name header.
		return contains(b, "FileRead")
	}, teatest.WithDuration(3*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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
		// Backlog #45 — GET /commands hydration. Empty list keeps the
		// autocomplete popup driven by the compile-time staticEntries.
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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
		return contains(b, "▸")
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

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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
		// Backlog #45 — GET /commands hydration. Empty list keeps the
		// autocomplete popup driven by the compile-time staticEntries.
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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
		// Backlog #45 — GET /commands hydration. Empty list keeps the
		// autocomplete popup driven by the compile-time staticEntries.
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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
		return contains(b, "▸")
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

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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
		// Backlog #45 — GET /commands hydration. Empty list keeps the
		// autocomplete popup driven by the compile-time staticEntries.
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_reconnectsSSEOnSessionPivot guards H10: /clear and /rollback pivot the
// session id BETWEEN turns via a NewSessionID side-effect. The old session's
// SSE stays idle and never closes to trigger sseDoneMsg, so the TUI must
// reconnect to the NEW session explicitly — otherwise the next turn's events
// render nowhere and the UI looks frozen. We drive the pivot and assert an SSE
// connection opens against the new session id.
func TestApp_reconnectsSSEOnSessionPivot(t *testing.T) {
	const oldID = "sess-old"
	const newID = "sess-new"
	var oldEvents, newEvents int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/messages"):
			fmt.Fprint(w, `{"messages":[]}`)
			return
		case strings.HasSuffix(path, "/skills"):
			fmt.Fprint(w, `{"skills":[]}`)
			return
		case strings.HasSuffix(path, "/commands") && r.Method == http.MethodGet:
			fmt.Fprint(w, `{"commands":[]}`)
			return
		case strings.HasSuffix(path, "/events"):
			switch {
			case strings.Contains(path, "/"+newID+"/"):
				atomic.AddInt32(&newEvents, 1)
			case strings.Contains(path, "/"+oldID+"/"):
				atomic.AddInt32(&oldEvents, 1)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			// Hold the connection open + idle (a between-turns subscription)
			// until the client tears it down (reconnect) or the program exits.
			<-r.Context().Done()
			return
		}
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New(oldID, srv.URL), teatest.WithInitialTermSize(80, 24))

	// Wait for the initial SSE connection to the OLD session.
	waitFor := func(counter *int32) bool {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if atomic.LoadInt32(counter) >= 1 {
				return true
			}
			time.Sleep(20 * time.Millisecond)
		}
		return false
	}
	if !waitFor(&oldEvents) {
		t.Fatal("initial SSE connection to the old session never established")
	}

	// Simulate /clear: a commandDispatchedMsg carrying a NewSessionID pivot.
	tm.Send(commandDispatchedMsg{
		name: "clear",
		resp: &transport.CommandResponse{
			Output:      "cleared",
			SideEffects: &transport.CommandSideEffects{NewSessionID: newID},
		},
	})

	// The load-bearing assertion: the SSE must reconnect to the NEW session.
	// Pre-fix the stream stayed on the old session and this never happens.
	if !waitFor(&newEvents) {
		t.Fatalf("SSE did not reconnect to new session %q after pivot (old=%d new=%d)",
			newID, atomic.LoadInt32(&oldEvents), atomic.LoadInt32(&newEvents))
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
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

// Backlog #46 (2026-05-19) — `/theme` no longer applies + persists
// client-side. The server's applyAndPersistTheme (pickers.ts) handles
// persistence; the themeChanged side-effect tells the TUI to apply
// the theme to m.theme + components. These two replaced tests
// (TestApp_ThemeSwitchWritesConfig + TestApp_ThemeSwitchPreserves-
// OtherConfigFields) verified the OLD Go-side persistence path that
// has been deleted. The equivalent TS-side behavior is covered by
// tests/commands/pickers.test.ts and config/store.ts's setAt tests.

// TestApp_PromptToSendAutoFiresTurn pins the prompt-type slash-command
// contract: when /commands returns a non-empty `promptToSend`, the TUI
// must auto-POST that body as a turn — the server has already done the
// expansion. Without this, /init / /commit / every skill-sourced command
// renders only the summary line and the user has to manually re-type
// the prompt.
//
// Mirrors what sov drive does at src/cli/driveCommand.ts:475.
func TestApp_PromptToSendAutoFiresTurn(t *testing.T) {
	const sessionID = "test-session"
	const promptBody = "Expanded prompt body to send as turn."

	var (
		mu             sync.Mutex
		commandPosts   int
		turnPostsBody  [][]byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /commands POST — return a prompt-type response.
		if r.Method == http.MethodPost && r.URL.Path == "/sessions/"+sessionID+"/commands" {
			mu.Lock()
			commandPosts++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(transport.CommandResponse{
				Output:       "Prompt-type slash command. Sending …",
				PromptToSend: promptBody,
			})
			return
		}
		// /turns POST — capture the body to assert promptToSend was sent.
		if r.Method == http.MethodPost && r.URL.Path == "/sessions/"+sessionID+"/turns" {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			turnPostsBody = append(turnPostsBody, body)
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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

	tm := teatest.NewTestModel(t, New(sessionID, srv.URL), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "▸")
	}, teatest.WithDuration(2*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/init")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	// Wait for both POSTs to land.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		gotCmd := commandPosts
		gotTurn := len(turnPostsBody)
		mu.Unlock()
		if gotCmd > 0 && gotTurn > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	gotCmd := commandPosts
	gotTurnBodies := append([][]byte(nil), turnPostsBody...)
	mu.Unlock()

	if gotCmd != 1 {
		t.Fatalf("expected 1 POST to /commands, got %d", gotCmd)
	}
	if len(gotTurnBodies) != 1 {
		t.Fatalf("expected 1 POST to /turns (the auto-fire), got %d", len(gotTurnBodies))
	}
	if !bytes.Contains(gotTurnBodies[0], []byte(promptBody)) {
		t.Fatalf("auto-fired /turns body = %q, want to contain promptToSend body %q",
			string(gotTurnBodies[0]), promptBody)
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_NoPromptToSendDoesNotFireTurn guards the negative case: local
// slash commands (/help, /cost, etc.) come back with no promptToSend and
// MUST NOT trigger a turn POST.
func TestApp_NoPromptToSendDoesNotFireTurn(t *testing.T) {
	const sessionID = "test-session"

	var (
		mu            sync.Mutex
		turnPostCount int
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/sessions/"+sessionID+"/commands" {
			_ = json.NewEncoder(w).Encode(transport.CommandResponse{
				Output: "help text content",
				// PromptToSend deliberately unset.
			})
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/sessions/"+sessionID+"/turns" {
			mu.Lock()
			turnPostCount++
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			fmt.Fprint(w, `{"commands":[]}`)
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

	tm := teatest.NewTestModel(t, New(sessionID, srv.URL), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return contains(b, "▸")
	}, teatest.WithDuration(2*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/help")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	// Give the TUI a moment to (incorrectly) fire a turn if it would.
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	got := turnPostCount
	mu.Unlock()
	if got != 0 {
		t.Fatalf("expected 0 POSTs to /turns for local command, got %d", got)
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

func TestApp_ThemeChangedSideEffectAppliesTheme(t *testing.T) {
	// Backlog #46 — when the server's commandDispatchedMsg carries
	// sideEffects.themeChanged, the TUI applies the theme client-side
	// (calls theme.Resolve + updates m.theme + propagates to
	// transcript/autocomplete/statusline).
	m := New("s-theme-applied", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	beforeName := m.theme.Name
	if beforeName == "light" {
		// Pre-condition: starting theme should not be 'light' (default
		// is 'dark'). If env state contradicts, skip the test.
		t.Skip("starting theme is already 'light'; cannot verify switch")
	}

	resp := &transport.CommandResponse{
		Output: "theme set to light",
		SideEffects: &transport.CommandSideEffects{
			ThemeChanged: "light",
		},
	}
	model, _ = m.Update(commandDispatchedMsg{name: "theme", resp: resp})
	m = model.(Model)

	if m.theme.Name != "light" {
		t.Errorf("theme not applied: before=%s want=light got=%s", beforeName, m.theme.Name)
	}
}

func TestApp_ThemeChangedSideEffectUnknownNameSurfacesDimMarker(t *testing.T) {
	// Backlog #46 — unknown theme name in themeChanged should NOT
	// crash; the TUI logs a dim transcript marker and keeps the
	// current theme.
	m := New("s-theme-unknown", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	beforeName := m.theme.Name

	resp := &transport.CommandResponse{
		Output: "theme set to nonsense",
		SideEffects: &transport.CommandSideEffects{
			ThemeChanged: "nonsense-theme-that-does-not-exist",
		},
	}
	model, _ = m.Update(commandDispatchedMsg{name: "theme", resp: resp})
	m = model.(Model)

	if m.theme.Name != beforeName {
		t.Errorf("theme should not change on unknown name; was=%s now=%s", beforeName, m.theme.Name)
	}
	// ux-fixes round 5 — the dim error marker now flows into terminal
	// scrollback via tea.Println; inspect the drained snapshot.
	if !strings.Contains(scrollbackContent(m), "could not apply theme") {
		t.Errorf("expected dim marker for unknown theme in scrollback; got %q", scrollbackContent(m))
	}
}

// M9.6 T1 — mouse click handling tests.

// ux-fixes round 5 — mouse handling is gone (no alt screen, no mouse
// capture; terminal owns scroll + selection natively). The previously
// covered behaviors (toolcard click-to-expand, wheel-forwards-to-transcript)
// were retired with the inline-mode refactor. Tool cards now print
// fully expanded into terminal scrollback at tool_result time, so the
// "toggle on click" contract no longer exists. Wheel events bypass the
// TUI entirely, scrolling the terminal natively.

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

// M9.6 T3 — /skills reload + compaction cache invalidation.

func TestApp_SlashSkillsNoVerbShowsListAndVerbs(t *testing.T) {
	// M11.17 — bare /skills now renders the skill list (or empty marker)
	// + a verbs-cheatsheet line so users discover install/uninstall/reload.
	m := New("s-usg", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	for _, r := range "/skills" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	// ux-fixes round 5 — feedback flows into scrollback via tea.Println;
	// inspect the drained snapshot instead of View().
	out := scrollbackContent(m)
	if !strings.Contains(out, "verbs:") {
		t.Errorf("expected verbs-cheatsheet line in scrollback: %q", out)
	}
	if !strings.Contains(out, "install") || !strings.Contains(out, "uninstall") || !strings.Contains(out, "reload") {
		t.Errorf("expected install/uninstall/reload in cheatsheet: %q", out)
	}
}

func TestApp_SlashSkillsUnknownVerbErrors(t *testing.T) {
	m := New("s-unk", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	for _, r := range "/skills bogus" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	out := scrollbackContent(m)
	if !strings.Contains(out, "unknown") || !strings.Contains(out, "bogus") {
		t.Errorf("expected unknown-verb error in scrollback: %q", out)
	}
}

func TestApp_SlashSkillsReloadNoServerNoOps(t *testing.T) {
	m := New("s-noserver", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	for _, r := range "/skills reload" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	out := scrollbackContent(m)
	if !strings.Contains(out, "unavailable") {
		t.Errorf("expected 'unavailable' marker for /skills reload without server: %q", out)
	}
}

func TestApp_SlashSkillsReloadWithServerFetchesSkills(t *testing.T) {
	var requestCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/skills") {
			atomic.AddInt32(&requestCount, 1)
			fmt.Fprint(w, `{"skills":[{"name":"reloaded","description":"d","whenToUse":"w"}]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New("s-rel", srv.URL), teatest.WithInitialTermSize(80, 24))
	// Wait for initial skills fetch (1 request from boot).
	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return atomic.LoadInt32(&requestCount) >= 1
	}, teatest.WithDuration(2*time.Second))

	// Send /skills reload + ENTER.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/skills reload")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return atomic.LoadInt32(&requestCount) >= 2
	}, teatest.WithDuration(2*time.Second))

	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestApp_idleCheckRestartsSpinnerAfterContentEvent guards the ux-fixes
// behavior: after a text_delta clears the initial thinking spinner, the
// scheduled idleCheckMsg should re-arm a spinner so the post-text/
// pre-tool gap reads as "still thinking" instead of as a dead UI.
func TestApp_idleCheckRestartsSpinnerAfterContentEvent(t *testing.T) {
	m := New("s-idle", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	env := newTestEnvelope("text_delta", "s-idle", 1,
		`{"type":"text_delta","seq":1,"sessionId":"s-idle","block":0,"text":"intro"}`)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)

	if m.thinkingPending {
		t.Fatalf("text_delta should clear thinking spinner before idle check")
	}

	captured := m.deltaGen
	model, _ = m.Update(idleCheckMsg{gen: captured})
	m = model.(Model)

	if !m.thinkingPending {
		t.Errorf("idle check with current gen should restart spinner; thinkingPending=%v", m.thinkingPending)
	}
	if m.spinnerLineIdx < 0 {
		t.Errorf("idle check should append a live spinner line; spinnerLineIdx=%d", m.spinnerLineIdx)
	}
}

// TestApp_idleCheckDroppedWhenSupersededByNewerEvent guards the
// stale-gen branch: when a newer SSE event arrives before the
// idle-check tick fires, m.deltaGen advances past the captured gen
// and the tick must no-op rather than appending an orphaned spinner.
func TestApp_idleCheckDroppedWhenSupersededByNewerEvent(t *testing.T) {
	m := New("s-stale", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	env1 := newTestEnvelope("text_delta", "s-stale", 1,
		`{"type":"text_delta","seq":1,"sessionId":"s-stale","block":0,"text":"part1"}`)
	model, _ = m.Update(sseMsg{env: env1})
	m = model.(Model)
	stale := m.deltaGen

	env2 := newTestEnvelope("text_delta", "s-stale", 2,
		`{"type":"text_delta","seq":2,"sessionId":"s-stale","block":0,"text":"part2"}`)
	model, _ = m.Update(sseMsg{env: env2})
	m = model.(Model)

	model, _ = m.Update(idleCheckMsg{gen: stale})
	m = model.(Model)

	if m.thinkingPending {
		t.Errorf("stale-gen idle check must not restart spinner; thinkingPending=%v", m.thinkingPending)
	}
}

// TestApp_idleCheckDroppedAfterTerminalEvent guards the turn-boundary
// case: once turn_complete arrives, deltaGen advances (via
// clearThinkingIfPending) and any pending idle-check from an earlier
// content event must no-op so the spinner doesn't appear after the
// turn has visibly ended.
func TestApp_idleCheckDroppedAfterTerminalEvent(t *testing.T) {
	m := New("s-done", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	env := newTestEnvelope("text_delta", "s-done", 1,
		`{"type":"text_delta","seq":1,"sessionId":"s-done","block":0,"text":"reply"}`)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	captured := m.deltaGen

	tc := newTestEnvelope("turn_complete", "s-done", 2,
		`{"type":"turn_complete","seq":2,"sessionId":"s-done","finishReason":"end_turn"}`)
	model, _ = m.Update(sseMsg{env: tc})
	m = model.(Model)

	model, _ = m.Update(idleCheckMsg{gen: captured})
	m = model.(Model)

	if m.thinkingPending {
		t.Errorf("post-turn_complete idle check must not restart spinner; thinkingPending=%v", m.thinkingPending)
	}
}

// Phase 2 T5 — delegator_* event rendering tests. The SSE switch in
// handleEvent must decode each event and queue the corresponding
// compact-line via m.print so the user sees the routing observability
// flow in scrollback. The tests drive handleEvent directly (matching
// the turn_error / stall_detected pattern above) and assert the queued
// pendingPrintln contains the expected substrings.

func TestApp_renderDelegatorPlanLine(t *testing.T) {
	m := New("s-del-plan", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	m.pendingPrintln = nil
	env := newTestEnvelope("delegator_plan", "s-del-plan", 1,
		`{"type":"delegator_plan","seq":1,"sessionId":"s-del-plan"}`)
	_ = m.handleEvent(env)
	joined := strings.Join(m.pendingPrintln, "\n")
	if !strings.Contains(joined, "Delegating") {
		t.Errorf("delegator_plan not queued for scrollback: %q", joined)
	}
}

func TestApp_renderDelegatorAtomStartedLine(t *testing.T) {
	m := New("s-del-start", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	m.pendingPrintln = nil
	env := newTestEnvelope("delegator_atom_started", "s-del-start", 2,
		`{"type":"delegator_atom_started","seq":2,"sessionId":"s-del-start","atomIndex":0,"laneName":"cheap-task","promptPreview":"Summarize this"}`)
	_ = m.handleEvent(env)
	joined := strings.Join(m.pendingPrintln, "\n")
	if !strings.Contains(joined, "atom 0 on cheap-task") {
		t.Errorf("delegator_atom_started not queued with expected substring: %q", joined)
	}
	if !strings.Contains(joined, "Summarize this") {
		t.Errorf("delegator_atom_started preview missing from queued line: %q", joined)
	}
}

func TestApp_renderDelegatorAtomCompleteLine_success(t *testing.T) {
	m := New("s-del-ok", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	m.pendingPrintln = nil
	env := newTestEnvelope("delegator_atom_complete", "s-del-ok", 3,
		`{"type":"delegator_atom_complete","seq":3,"sessionId":"s-del-ok","atomIndex":0,"laneName":"cheap-task","success":true,"durationMs":1234}`)
	_ = m.handleEvent(env)
	joined := strings.Join(m.pendingPrintln, "\n")
	if !strings.Contains(joined, "atom 0 on cheap-task") {
		t.Errorf("delegator_atom_complete success line missing identifier: %q", joined)
	}
	if !strings.Contains(joined, "(1234ms)") {
		t.Errorf("delegator_atom_complete duration missing: %q", joined)
	}
	if strings.Contains(joined, "failed") {
		t.Errorf("success line should not contain 'failed': %q", joined)
	}
}

func TestApp_renderDelegatorAtomCompleteLine_failure(t *testing.T) {
	m := New("s-del-fail", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	m.pendingPrintln = nil
	env := newTestEnvelope("delegator_atom_complete", "s-del-fail", 4,
		`{"type":"delegator_atom_complete","seq":4,"sessionId":"s-del-fail","atomIndex":1,"laneName":"reasoning","success":false,"durationMs":42}`)
	_ = m.handleEvent(env)
	joined := strings.Join(m.pendingPrintln, "\n")
	if !strings.Contains(joined, "failed (42ms)") {
		t.Errorf("delegator_atom_complete failure line missing 'failed (42ms)': %q", joined)
	}
}

func TestApp_renderDelegatorCompleteLine(t *testing.T) {
	m := New("s-del-done", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	m.pendingPrintln = nil
	env := newTestEnvelope("delegator_complete", "s-del-done", 5,
		`{"type":"delegator_complete","seq":5,"sessionId":"s-del-done","totalAtomCount":3,"laneDistribution":{"cheap-task":2,"reasoning":1}}`)
	_ = m.handleEvent(env)
	joined := strings.Join(m.pendingPrintln, "\n")
	if !strings.Contains(joined, "Done.") {
		t.Errorf("delegator_complete missing 'Done.' headline: %q", joined)
	}
	if !strings.Contains(joined, "3 atom(s)") {
		t.Errorf("delegator_complete missing total count: %q", joined)
	}
	if !strings.Contains(joined, "cheap-task=2") {
		t.Errorf("delegator_complete missing lane distribution entry: %q", joined)
	}
}

// 2026-05-24 config UX rebuild — SSE side-effect tests for inputOpen
// and verboseChanged.

// sampleInputOpenPayload builds a non-masked InputOpenPayload used
// across the inputOpen tests.
func sampleInputOpenPayload() *transport.InputOpenPayload {
	p := transport.InputOpenPayload{
		Title:       "defaultModel",
		Subtitle:    "Model used when no --model flag is supplied.",
		Initial:     "claude-sonnet-4-6",
		Placeholder: "claude-sonnet-4-6",
		Masked:      false,
	}
	p.OnSubmit.Command = "config set defaultModel"
	return &p
}

func TestApp_InputOpenSideEffectOpensInputCard(t *testing.T) {
	m := New("s-input-open", "")
	resp := &transport.CommandResponse{
		Output: "",
		SideEffects: &transport.CommandSideEffects{
			InputOpen: sampleInputOpenPayload(),
		},
	}
	model, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := model.(Model)

	if app.inputCard == nil {
		t.Fatalf("expected inputCard to be non-nil after inputOpen side-effect")
	}
	if app.inputCard.Command() != "config set defaultModel" {
		t.Errorf("inputCard.Command() = %q; want %q", app.inputCard.Command(), "config set defaultModel")
	}
	if app.inputCard.Value() != "claude-sonnet-4-6" {
		t.Errorf("inputCard.Value() = %q; want %q (pre-populated from Initial)", app.inputCard.Value(), "claude-sonnet-4-6")
	}
}

func TestApp_InputOpenClearsActivePicker(t *testing.T) {
	// When an inputOpen side-effect arrives while a picker is open
	// (e.g., user selected a string field from a /config submenu),
	// the picker is dismissed in favor of the input editor.
	m := New("s-input-replaces-picker", "")
	pickerResp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	model, _ := m.Update(commandDispatchedMsg{name: "config", resp: pickerResp})
	app := model.(Model)
	if app.picker == nil {
		t.Fatal("setup: expected picker to be open")
	}
	// Now fire the inputOpen.
	inputResp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{InputOpen: sampleInputOpenPayload()},
	}
	model, _ = app.Update(commandDispatchedMsg{name: "config", resp: inputResp})
	app = model.(Model)
	if app.picker != nil {
		t.Errorf("expected picker to be nil after inputOpen takes over; got %+v", *app.picker)
	}
	if app.inputCard == nil {
		t.Fatal("expected inputCard to be non-nil after inputOpen")
	}
}

func TestApp_InputCardEscClearsWithoutDispatch(t *testing.T) {
	m := New("s-input-esc", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{InputOpen: sampleInputOpenPayload()},
	}
	model, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := model.(Model)

	model, _ = app.Update(tea.KeyMsg{Type: tea.KeyEsc})
	app = model.(Model)

	if app.inputCard != nil {
		t.Errorf("inputCard should be nil after Esc; got %+v", *app.inputCard)
	}
	if !strings.Contains(scrollbackContent(app), "cancelled") {
		t.Errorf("expected '(cancelled)' marker in scrollback after Esc; got %q", scrollbackContent(app))
	}
}

func TestApp_InputCardEnterDispatchesValueViaSlash(t *testing.T) {
	// With baseURL set, Enter should return a non-nil tea.Cmd carrying
	// the dispatch. We don't run the Cmd — it would hit a fake URL.
	m := New("s-input-enter", "http://127.0.0.1:1")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{InputOpen: sampleInputOpenPayload()},
	}
	model, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := model.(Model)
	if app.inputCard == nil {
		t.Fatal("setup: inputCard should be open")
	}

	model, cmd := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = model.(Model)

	if app.inputCard != nil {
		t.Errorf("inputCard should be cleared after Enter; got %+v", *app.inputCard)
	}
	if cmd == nil {
		t.Error("Enter with baseURL set should return a dispatch tea.Cmd")
	}
}

func TestApp_InputCardEnterNoServerNoOps(t *testing.T) {
	// Without a server (baseURL=""), Enter still clears the card but
	// no dispatch is fired — same contract as the picker.
	m := New("s-input-no-server", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{InputOpen: sampleInputOpenPayload()},
	}
	model, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := model.(Model)

	model, _ = app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = model.(Model)

	if app.inputCard != nil {
		t.Errorf("inputCard should be cleared even without server; got %+v", *app.inputCard)
	}
	if !strings.Contains(scrollbackContent(app), "no server") {
		t.Errorf("expected '(no server)' marker in scrollback; got %q", scrollbackContent(app))
	}
}

func TestApp_InputCardForwardsTypingKeys(t *testing.T) {
	// When the InputCard is open, character keystrokes should land in
	// the embedded textinput (not the main prompt). The picker absorbs
	// every key — the InputCard forwards non-Enter/Esc to its textinput.
	// Initial="claude-sonnet-4-6"; typing "-2" should extend to
	// "claude-sonnet-4-6-2".
	m := New("s-input-typing", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{InputOpen: sampleInputOpenPayload()},
	}
	model, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := model.(Model)

	// Type "-2" via two KeyMsg.
	model, _ = app.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'-'}})
	app = model.(Model)
	model, _ = app.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'2'}})
	app = model.(Model)

	if app.inputCard == nil {
		t.Fatal("inputCard should still be open after typing")
	}
	if want := "claude-sonnet-4-6-2"; app.inputCard.Value() != want {
		t.Errorf("inputCard.Value() after typing: got %q want %q", app.inputCard.Value(), want)
	}
}

func TestApp_VerboseChangedSideEffectFlipsVerboseRaw(t *testing.T) {
	m := New("s-verbose-true", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	beforeVerbose := m.verboseRaw
	if beforeVerbose {
		t.Skip("baseline verboseRaw already true — cannot verify flip to true")
	}

	verboseTrue := true
	resp := &transport.CommandResponse{
		Output: "verbose set to true",
		SideEffects: &transport.CommandSideEffects{
			VerboseChanged: &verboseTrue,
		},
	}
	model, _ = m.Update(commandDispatchedMsg{name: "config", resp: resp})
	m = model.(Model)

	if !m.verboseRaw {
		t.Errorf("verboseRaw should be true after VerboseChanged=true; got %v", m.verboseRaw)
	}
}

func TestApp_VerboseChangedSideEffectFlipsBackToFalse(t *testing.T) {
	m := New("s-verbose-false", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Force-set verboseRaw to true to verify the flip-to-false path.
	m.verboseRaw = true

	verboseFalse := false
	resp := &transport.CommandResponse{
		Output: "verbose set to false",
		SideEffects: &transport.CommandSideEffects{
			VerboseChanged: &verboseFalse,
		},
	}
	model, _ = m.Update(commandDispatchedMsg{name: "config", resp: resp})
	m = model.(Model)

	if m.verboseRaw {
		t.Errorf("verboseRaw should be false after VerboseChanged=false; got %v", m.verboseRaw)
	}
}

func TestApp_VerboseChangedNilPointerNoOps(t *testing.T) {
	// Defensive — a CommandResponse with sideEffects but no
	// VerboseChanged pointer should not touch verboseRaw.
	m := New("s-verbose-nil", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	before := m.verboseRaw

	resp := &transport.CommandResponse{
		Output:      "some other output",
		SideEffects: &transport.CommandSideEffects{},
	}
	model, _ = m.Update(commandDispatchedMsg{name: "config", resp: resp})
	m = model.(Model)

	if m.verboseRaw != before {
		t.Errorf("verboseRaw should be unchanged when VerboseChanged=nil; before=%v after=%v", before, m.verboseRaw)
	}
}

func TestApp_WithInitialCommandSetsField(t *testing.T) {
	// The builder method seeds the field so the WindowSizeMsg handler
	// can fire the command once the splash is up.
	m := New("s-init-cmd", "").WithInitialCommand("/config")
	if m.initialCommand != "/config" {
		t.Errorf("WithInitialCommand: got %q want %q", m.initialCommand, "/config")
	}
	if m.initialFired {
		t.Errorf("initialFired should start false; got true")
	}
}

func TestApp_WithInitialCommandTrimsWhitespace(t *testing.T) {
	m := New("s-init-cmd-trim", "").WithInitialCommand("  /config   ")
	if m.initialCommand != "/config" {
		t.Errorf("WithInitialCommand should trim; got %q", m.initialCommand)
	}
}

func TestApp_WithInitialCommandEmptyStaysEmpty(t *testing.T) {
	m := New("s-init-cmd-empty", "").WithInitialCommand("")
	if m.initialCommand != "" {
		t.Errorf("WithInitialCommand('') should leave field empty; got %q", m.initialCommand)
	}
}

func TestApp_InitialCommandFiresOnFirstWindowSizeMsg(t *testing.T) {
	// With initialCommand set and baseURL non-empty, the first
	// WindowSizeMsg should fire the command (returning a non-nil Cmd
	// via dispatchCommandCmd). The initialFired guard flips to true.
	m := New("s-init-cmd-fire", "http://127.0.0.1:1").WithInitialCommand("/config")
	model, cmd := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	if !m.initialFired {
		t.Errorf("initialFired should be true after first WindowSizeMsg")
	}
	if cmd == nil {
		t.Errorf("expected a non-nil tea.Cmd from initial-command fire")
	}
}

func TestApp_InitialCommandFiresOnlyOnce(t *testing.T) {
	// A second WindowSizeMsg (e.g., terminal resize) should NOT re-fire
	// the initial command. The guard ensures one-shot semantics.
	m := New("s-init-cmd-once", "http://127.0.0.1:1").WithInitialCommand("/config")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	// Resize.
	model, cmd := m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	m = model.(Model)
	// The resize WindowSizeMsg should not re-fire the dispatch (no
	// dispatch Cmd returned).
	if cmd != nil {
		// Inspect — dispatchCommandCmd returns a closure; if the guard
		// failed it would also return a non-nil cmd. We can't easily
		// type-assert the closure's identity, but we can pin that the
		// fired flag stays true (which it would even on a wrong re-fire).
		// The stronger assertion is initialFired stays true and no
		// second fire happens. Given the guard, the cmd should be nil
		// (m.respond(nil)) on the second WindowSizeMsg.
		t.Errorf("expected nil cmd on second WindowSizeMsg (initial command should fire only once); got non-nil")
	}
	if !m.initialFired {
		t.Errorf("initialFired should remain true after second WindowSizeMsg")
	}
}

func TestApp_InitialCommandNoOpWithoutBaseURL(t *testing.T) {
	// Without a server, the splash branch is skipped — and so is the
	// initial-command fire (it requires baseURL non-empty).
	m := New("s-init-cmd-no-server", "").WithInitialCommand("/config")
	model, cmd := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	if m.initialFired {
		t.Errorf("initialFired should stay false without baseURL")
	}
	if cmd != nil {
		t.Errorf("expected nil cmd when no server; got non-nil")
	}
}
