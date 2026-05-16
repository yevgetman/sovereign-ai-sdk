// Phase 16.1 M9 — Integration smoke at the Model level.
//
// Drives every M9 visible surface through Model.Update + View:
//   - T3 markdown rendering of streamed assistant text
//   - T4 chroma syntax highlight on a tool_result with language hint
//   - T7 styled goodbye card on session_summary
//   - T7 compaction marker on compaction_complete
//   - T8 slash autocomplete popup appears on /-prefix input
//   - T9 mouse wheel events don't panic
//   - T10 statusline reflects status_update events
//   - T1 /theme switch updates the theme used for downstream renders
//
// TS-side wire smoke lives at tests/server/m9Full.test.ts. Both surfaces
// must be green for M9 close-out.

package app

import (
	"encoding/json"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestM9_MarkdownRenderedInAssistantText(t *testing.T) {
	m := New("s-md", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	env := newTestEnvelope("text_delta", "s-md", 1,
		`{"type":"text_delta","seq":1,"sessionId":"s-md","block":0,"text":"**bold-md9**"}`)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	view := m.View()
	if strings.Contains(view, "**bold-md9**") {
		t.Errorf("raw markdown leaked through render.Markdown: %q", view)
	}
	if !strings.Contains(view, "bold-md9") {
		t.Errorf("markdown content lost: %q", view)
	}
}

func TestM9_ToolResultRendersWithCard(t *testing.T) {
	m := New("s-tool", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"tool_result","seq":1,"sessionId":"s-tool","block":0,"tool":"FileRead","input":{"path":"a.go"},"output":"package main","renderHint":"text","language":"go"}`
	env := newTestEnvelope("tool_result", "s-tool", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	view := m.View()
	if !strings.Contains(view, "FileRead") {
		t.Errorf("tool card missing tool name: %q", view)
	}
}

func TestM9_GoodbyeCardRendersOnSessionSummary(t *testing.T) {
	m := New("s-bye", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	m = model.(Model)
	raw := `{"type":"session_summary","seq":1,"sessionId":"s-bye","totalDispatched":1,"byAgent":{"review-memory":1},"tokens":{"input":50,"output":100,"estimatedCostUsd":0.001}}`
	env := newTestEnvelope("session_summary", "s-bye", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	view := m.View()
	if !strings.Contains(view, "Session summary") {
		t.Errorf("goodbye card title missing: %q", view)
	}
	if !strings.Contains(view, "$0.0010") {
		t.Errorf("goodbye card cost missing: %q", view)
	}
}

func TestM9_CompactionMarkerRendersOnCompactionComplete(t *testing.T) {
	m := New("s-cc", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m = model.(Model)
	raw := `{"type":"compaction_complete","seq":1,"sessionId":"parent-session","activeSessionId":"child-1234","summary":"summarized","estimatedBeforeTokens":1000,"estimatedAfterTokens":500}`
	env := newTestEnvelope("compaction_complete", "parent-session", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	view := m.View()
	if !strings.Contains(view, "compacted") {
		t.Errorf("compaction marker missing 'compacted': %q", view)
	}
	if !strings.Contains(view, "1000") || !strings.Contains(view, "500") {
		t.Errorf("compaction marker missing token deltas: %q", view)
	}
}

func TestM9_AutocompletePopupAppearsOnSlash(t *testing.T) {
	m := New("s-ac", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	m = model.(Model)
	if !m.autocomplete.Visible() {
		t.Error("autocomplete popup should be visible after typing /")
	}
	view := m.View()
	if !strings.Contains(view, "/compact") {
		t.Errorf("autocomplete popup should list /compact: %q", view)
	}
}

func TestM9_MouseWheelDoesNotPanic(t *testing.T) {
	m := New("s-mouse", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Wheel-up message — should not panic.
	model, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonWheelUp})
	_ = model.(Model)
}

func TestM9_StatusUpdateUpdatesStatusLine(t *testing.T) {
	m := New("s-su", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m = model.(Model)
	raw := `{"type":"status_update","seq":1,"sessionId":"s-su","streaming":true,"cost":0.0042,"tokensIn":100,"tokensOut":200}`
	env := newTestEnvelope("status_update", "s-su", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	if !m.statusLine.Streaming {
		t.Error("statusline.Streaming should be true after status_update")
	}
	if m.statusLine.Cost != 0.0042 {
		t.Errorf("statusline.Cost: got %v want 0.0042", m.statusLine.Cost)
	}
	if m.statusLine.TokensIn != 100 || m.statusLine.TokensOut != 200 {
		t.Errorf("statusline tokens: got in=%d out=%d", m.statusLine.TokensIn, m.statusLine.TokensOut)
	}
	view := m.View()
	if !strings.Contains(view, "$0.0042") {
		t.Errorf("statusline view missing cost: %q", view)
	}
}

func TestM9_ThemeSwitchAltersRender(t *testing.T) {
	m := New("s-theme", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	// Append an assistant line so the rendered transcript has content.
	env := newTestEnvelope("text_delta", "s-theme", 1,
		`{"type":"text_delta","seq":1,"sessionId":"s-theme","block":0,"text":"hello world"}`)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	darkName := m.theme.Name

	// Send /theme light + ENTER via two messages.
	for _, r := range "/theme light" {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	if m.theme.Name != "light" {
		t.Errorf("theme not switched: %q (was %q)", m.theme.Name, darkName)
	}
}

func TestM9_StallDetectedSurfaceable(t *testing.T) {
	// M8 T7 wire event must still parse cleanly via the Go transport.
	// M9 doesn't render a badge yet (deferred to M9.5 visual polish), but
	// the schema must remain consumable.
	m := New("s-stall", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"stall_detected","seq":1,"sessionId":"s-stall","reason":"no edits","turn":3}`
	env := newTestEnvelope("stall_detected", "s-stall", 1, raw)
	// Should not panic even though M9 has no handler for stall_detected.
	model, _ = m.Update(sseMsg{env: env})
	_ = model.(Model)
}

// _ is a guard against the json import vanishing if all the inline
// raw-string envelopes get refactored away.
var _ = json.RawMessage(nil)
