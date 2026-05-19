// Package app — post-M11.5 polish tests for slash-autocomplete Enter
// handling and popup positioning.
//
// Covers:
//   - Enter on a visible popup fills the highlighted completion AND
//     submits in one keystroke (uxissue2).
//   - Enter on a visible popup with typed args preserves the args
//     (no-args guard prevents clobbering — caught by the earlier
//     slashSkillsReload test timeout).
//   - View() renders the popup AFTER the prompt, not before (uxissue1).

package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
)

// TestSlashAutocompleteEnterFillsAndSubmits covers the uxissue2 fix:
// typing a partial command like "/abou" and pressing Enter on the
// visible popup should fill `/about` and submit it (one keystroke),
// not send the literal partial text.
func TestSlashAutocompleteEnterFillsAndSubmits(t *testing.T) {
	var commandRequests int32
	var commandName string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Backlog #45 — GET /commands hydration. Empty list keeps the
		// autocomplete driven by staticEntries (which includes /about).
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"commands":[]}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/commands") {
			atomic.AddInt32(&commandRequests, 1)
			// Parse the body to capture which command was dispatched.
			body := make([]byte, 4096)
			n, _ := r.Body.Read(body)
			commandName = string(body[:n])
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"output":"about: ...","error":""}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			_, _ = w.Write([]byte(`{"messages":[]}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New("s-ac-enter", srv.URL), teatest.WithInitialTermSize(80, 24))

	// Type "/abou" — popup should show /about as the top match.
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/abou")})
	// Press Enter — should fill /about and dispatch.
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return atomic.LoadInt32(&commandRequests) >= 1
	}, teatest.WithDuration(2*time.Second))

	if !strings.Contains(commandName, `"name":"about"`) {
		t.Errorf("expected dispatched command name 'about', got body: %s", commandName)
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestSlashAutocompleteEnterPreservesArgs covers the no-args guard:
// typing "/cost extra" and pressing Enter must dispatch with args
// preserved — NOT clobber to just "/cost". (The slashSkillsReload
// test timed out when this guard was missing — this test makes the
// invariant explicit.)
func TestSlashAutocompleteEnterPreservesArgs(t *testing.T) {
	var capturedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Backlog #45 — separate GET /commands hydration from POST
		// dispatch so the body capture below doesn't get clobbered.
		if strings.HasSuffix(r.URL.Path, "/commands") && r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"commands":[]}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/commands") {
			body := make([]byte, 4096)
			n, _ := r.Body.Read(body)
			capturedBody = string(body[:n])
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"output":"ok","error":""}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			_, _ = w.Write([]byte(`{"messages":[]}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	defer srv.Close()

	tm := teatest.NewTestModel(t, New("s-ac-args", srv.URL), teatest.WithInitialTermSize(80, 24))

	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/cost extra")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		return capturedBody != ""
	}, teatest.WithDuration(2*time.Second))

	// Args MUST be preserved. The guard prevents the autocomplete
	// from clobbering "extra" with just the bare /cost completion.
	if !strings.Contains(capturedBody, `"name":"cost"`) {
		t.Errorf("expected dispatched command 'cost', got body: %s", capturedBody)
	}
	if !strings.Contains(capturedBody, `"args":"extra"`) {
		t.Errorf("expected args 'extra' preserved, got body: %s", capturedBody)
	}

	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

// TestSlashAutocompleteViewPositionsPopupBelowPrompt covers uxissue1:
// the popup must render AFTER the prompt in the View() output, not
// before. Renders View() with a synthetic visible popup and asserts
// the substring ordering.
func TestSlashAutocompleteViewPositionsPopupBelowPrompt(t *testing.T) {
	m := New("s-ac-layout", "")
	// Drive a window size so View() emits content.
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = updated.(Model)
	// Type a slash to make the popup visible. Bypasses the autocomplete
	// branch (no key handling required) by going through the regular
	// prompt-update path.
	updated, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	m = updated.(Model)

	view := m.View()

	// The prompt's `Prompt = "› "` is unique to the prompt input box
	// (slashautocomplete popup uses bold for selection, not a glyph
	// prefix). The popup's distinctive marker is "/about" — the first
	// alphabetical entry in staticEntries.
	promptIdx := strings.Index(view, "›")
	popupIdx := strings.Index(view, "/about")

	if promptIdx < 0 {
		t.Fatalf("expected prompt marker '›' in View; got:\n%s", view)
	}
	if popupIdx < 0 {
		t.Fatalf("expected '/about' entry in View when popup visible; got:\n%s", view)
	}
	if promptIdx >= popupIdx {
		t.Errorf(
			"expected prompt to appear BEFORE popup in View (uxissue1); promptIdx=%d popupIdx=%d",
			promptIdx,
			popupIdx,
		)
	}
}
