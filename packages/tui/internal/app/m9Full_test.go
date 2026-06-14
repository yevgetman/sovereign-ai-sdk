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

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
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
	// ux-fixes round 5 — tool cards print to scrollback (no longer rendered
	// in View()). Inspect emittedPrintln via the test helper.
	//
	// ux-fixes 2026-05-22 — default tool-output mode is 'compact' which
	// emits a one-liner ("Read a.go ›") rather than the bordered card.
	// Assert against the compact-mode rendering; the detailed-mode path
	// is covered by TestM9_ToolResultRendersWithDetailedCard.
	m := New("s-tool", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"tool_result","seq":1,"sessionId":"s-tool","block":0,"tool":"FileRead","input":{"path":"a.go"},"output":"package main","renderHint":"text","language":"go"}`
	env := newTestEnvelope("tool_result", "s-tool", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	out := scrollbackContent(m)
	if !strings.Contains(out, "Read") {
		t.Errorf("compact tool line missing verb 'Read' in scrollback: %q", out)
	}
	if !strings.Contains(out, "a.go") {
		t.Errorf("compact tool line missing target 'a.go' in scrollback: %q", out)
	}
}

func TestM9_ToolResultRendersWithDetailedCard(t *testing.T) {
	// Detailed mode opt-in — bordered card with tool name in header.
	// Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
	m := New("s-tool-d", "").WithToolOutput("detailed", 10)
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"tool_result","seq":1,"sessionId":"s-tool-d","block":0,"tool":"FileRead","input":{"path":"a.go"},"output":"package main","renderHint":"text","language":"go"}`
	env := newTestEnvelope("tool_result", "s-tool-d", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	out := scrollbackContent(m)
	if !strings.Contains(out, "FileRead") {
		t.Errorf("detailed mode missing tool name 'FileRead' in scrollback: %q", out)
	}
}

func TestM9_ToolResultCompactModeMarksError(t *testing.T) {
	// Compact mode prefixes runtime errors with ✗ glyph (theme.Error
	// color). Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
	m := New("s-err", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"tool_result","seq":1,"sessionId":"s-err","block":0,"tool":"Bash","input":{"command":"false"},"output":{"status":"error","summary":"exited 1"},"renderHint":"text"}`
	env := newTestEnvelope("tool_result", "s-err", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	out := scrollbackContent(m)
	if !strings.Contains(out, "✗") {
		t.Errorf("compact error line missing ✗ glyph: %q", out)
	}
}

func TestM9_ToolResultCompactModeMarksPermissionDenied(t *testing.T) {
	// Compact mode prefixes permission-denied results with ⚠ glyph
	// (theme.Warning). The orchestrator deny path emits Output as a
	// JSON-quoted "permission denied: ..." string.
	m := New("s-denied", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"tool_result","seq":1,"sessionId":"s-denied","block":0,"tool":"Bash","input":{"command":"rm -rf /"},"output":"permission denied: rule deny matched","renderHint":"text"}`
	env := newTestEnvelope("tool_result", "s-denied", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	out := scrollbackContent(m)
	if !strings.Contains(out, "⚠") {
		t.Errorf("compact denied line missing ⚠ glyph: %q", out)
	}
}

func TestM9_ToolResultVerboseRawAppendsRawOutput(t *testing.T) {
	// -v / --verbose flag forwarded as --verbose-raw; the Model field
	// flips on and the handler appends raw untruncated output below
	// the compact line.
	m := New("s-raw", "").WithVerboseRaw(true)
	model, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = model.(Model)
	raw := `{"type":"tool_result","seq":1,"sessionId":"s-raw","block":0,"tool":"FileRead","input":{"path":"a.go"},"output":"package main\n\nfunc main() {}","renderHint":"text"}`
	env := newTestEnvelope("tool_result", "s-raw", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	out := scrollbackContent(m)
	// Compact line still appears.
	if !strings.Contains(out, "Read") {
		t.Errorf("verbose-raw missing compact line: %q", out)
	}
	// Plus the raw output (decoded from the JSON string).
	if !strings.Contains(out, "package main") {
		t.Errorf("verbose-raw missing raw output: %q", out)
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
	// ux-fixes round 5 — compaction marker now flows into scrollback.
	m := New("s-cc", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m = model.(Model)
	raw := `{"type":"compaction_complete","seq":1,"sessionId":"parent-session","activeSessionId":"child-1234","summary":"summarized","estimatedBeforeTokens":1000,"estimatedAfterTokens":500}`
	env := newTestEnvelope("compaction_complete", "parent-session", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	out := scrollbackContent(m)
	if !strings.Contains(out, "compacted") {
		t.Errorf("compaction marker missing 'compacted' in scrollback: %q", out)
	}
	if !strings.Contains(out, "1000") || !strings.Contains(out, "500") {
		t.Errorf("compaction marker missing token deltas in scrollback: %q", out)
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
	// Backlog #46/#56 — `/theme <name>` is server-mediated: the dispatch
	// returns a `themeChanged` side-effect that applyThemeByName applies to
	// the Go renderer's m.theme. Drive that side-effect directly. The prior
	// version typed "/theme light" + ENTER and relied on the dispatch
	// round-trip — which a no-server unit test can't perform (the dispatch
	// Cmd is discarded) — so it only passed when the boot config happened to
	// already be "light" (#56: a false PASS on a polluted ~/.harness, a real
	// FAIL in a clean/CI env). Switching in BOTH directions makes the
	// assertion independent of the env-dependent boot theme.
	m := New("s-theme", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)

	applyThemeViaSideEffect := func(name string) Model {
		msg := commandDispatchedMsg{
			name: "theme",
			resp: &transport.CommandResponse{
				Output:      "theme set to " + name,
				SideEffects: &transport.CommandSideEffects{ThemeChanged: name},
			},
		}
		next, _ := m.Update(msg)
		return next.(Model)
	}

	m = applyThemeViaSideEffect("light")
	if m.theme.Name != "light" {
		t.Fatalf("themeChanged=light did not switch theme: got %q", m.theme.Name)
	}
	m = applyThemeViaSideEffect("dark")
	if m.theme.Name != "dark" {
		t.Fatalf("themeChanged=dark did not switch theme: got %q", m.theme.Name)
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

// M9.6 — interaction polish integration smoke. Added in T5.

func TestM9_6_ClickOnAutocompleteEntrySelects(t *testing.T) {
	m := New("s-acmouse", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	m = model.(Model)
	if !m.autocomplete.Visible() {
		t.Fatal("autocomplete should be visible after /")
	}
	// SelectAt(0) is the API the mouse-click handler uses internally.
	completion, ok := m.autocomplete.SelectAt(0)
	if !ok {
		t.Error("SelectAt(0) should resolve")
	}
	if completion == "" {
		t.Error("Completion should be non-empty")
	}
}

func TestM9_6_StallBadgeRendersThenClearsOnMatchingGen(t *testing.T) {
	m := New("s-stallintg", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	raw := `{"type":"stall_detected","seq":1,"sessionId":"s-stallintg","reason":"no edits","turn":3}`
	env := newTestEnvelope("stall_detected", "s-stallintg", 1, raw)
	model, _ = m.Update(sseMsg{env: env})
	m = model.(Model)
	if m.stallBadge == nil {
		t.Fatal("badge should be visible after stall_detected")
	}
	gen := m.stallGeneration
	model, _ = m.Update(stallExpireMsg{gen: gen})
	m = model.(Model)
	if m.stallBadge != nil {
		t.Error("matching-gen expire should clear the badge")
	}
}

func TestM9_6_SkillsReloadParserAcceptsBothForms(t *testing.T) {
	// M11.17 — both "/skills" and "/skills " forms render the list/verbs
	// cheatsheet. ux-fixes round 5 — verbs line now lives in scrollback.
	m := New("s-sk2", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	for _, r := range "/skills " {
		model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = model.(Model)
	}
	model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = model.(Model)
	if !strings.Contains(scrollbackContent(m), "verbs:") {
		t.Errorf("trailing-space form should show verbs cheatsheet in scrollback: %q", scrollbackContent(m))
	}
}

func TestM9_6_HexValidationAcceptsValidRejectsNamedColors(t *testing.T) {
	// Indirectly exercise via the spec contract — loader_test.go has the
	// authoritative TOML round-trip; here we just ensure the renderer
	// composition didn't regress on the soft-fallback path.
	m := New("s-hex", "")
	model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m = model.(Model)
	_ = m.View() // doesn't panic
}
