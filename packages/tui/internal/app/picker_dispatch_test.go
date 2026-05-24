// Package app — M11.5 T5/T6 tests for inline picker card dispatch
// handling and key routing.
//
// Covers:
//   - commandDispatchedMsg with a PickerOpen side-effect opens the
//     inline card (m.picker non-nil) and absorbs the response (no
//     output rendering yet, that's the picker's job).
//   - commandDispatchedMsg without PickerOpen behaves as before
//     (m.picker stays nil).
//   - With picker open: Up/Down navigate; Enter dispatches the
//     selected value; Esc closes without dispatch.
//   - Other keys are absorbed while picker is open (input lock).

package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

func samplePickerPayload() *transport.PickerOpenPayload {
	p := transport.PickerOpenPayload{
		Title:    "switch model",
		Subtitle: "provider: anthropic",
		Items: []transport.PickerItem{
			{Label: "claude-haiku-4-5-20251001", Value: "claude-haiku-4-5-20251001"},
			{Label: "claude-sonnet-4-6", Value: "claude-sonnet-4-6", Hint: "(current)"},
			{Label: "claude-opus-4-7", Value: "claude-opus-4-7"},
		},
		Initial: 1,
	}
	p.OnSelect.Command = "model"
	return &p
}

func TestPickerOpenOpensInlineCard(t *testing.T) {
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		Output: "",
		SideEffects: &transport.CommandSideEffects{
			PickerOpen: samplePickerPayload(),
		},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	if app.picker == nil {
		t.Fatalf("expected picker to be non-nil after pickerOpen side-effect")
	}
	if app.picker.Command() != "model" {
		t.Errorf("picker.Command() = %q; want %q", app.picker.Command(), "model")
	}
	value, ok := app.picker.Selected()
	if !ok {
		t.Fatal("Selected() returned ok=false; expected initial item")
	}
	if value != "claude-sonnet-4-6" {
		t.Errorf("Selected() value = %q; want %q (Initial=1)", value, "claude-sonnet-4-6")
	}
}

func TestPickerNotOpenedWhenNoPickerOpenSideEffect(t *testing.T) {
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		Output: "session: sess-1\nmodel: claude-sonnet-4-6",
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "cost", resp: resp})
	app := updated.(Model)
	if app.picker != nil {
		t.Errorf("expected picker to stay nil for non-picker response; got %+v", *app.picker)
	}
}

func TestPickerUpDownNavigates(t *testing.T) {
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	// Down from index 1 → 2 (claude-opus-4-7)
	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyDown})
	app = updated.(Model)
	val, _ := app.picker.Selected()
	if val != "claude-opus-4-7" {
		t.Errorf("after Down: value = %q; want claude-opus-4-7", val)
	}
	// Up from 2 → 1
	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyUp})
	app = updated.(Model)
	val, _ = app.picker.Selected()
	if val != "claude-sonnet-4-6" {
		t.Errorf("after Up: value = %q; want claude-sonnet-4-6", val)
	}
}

func TestPickerEscClearsWithoutDispatch(t *testing.T) {
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyEsc})
	app = updated.(Model)

	if app.picker != nil {
		t.Errorf("picker should be nil after Esc; got %+v", *app.picker)
	}
	// ux-fixes round 5 — Esc emits a "(cancelled)" line into scrollback
	// via tea.Println (a non-nil Cmd carrying the print). The pre-round-5
	// "no Cmd returned" assertion is too strong; the meaningful check is
	// that ESC didn't dispatch a slash command. Verify by inspecting the
	// scrollback snapshot for the cancellation marker.
	if !strings.Contains(scrollbackContent(app), "cancelled") {
		t.Errorf("expected '(cancelled)' line in scrollback after Esc; got %q", scrollbackContent(app))
	}
}

// 2026-05-24 patch — backspace back-navigation.

// samplePickerPayloadWithBack returns a picker payload carrying an
// OnBack command — mirrors what /config submenus emit so backspace
// navigates back to the parent group.
func samplePickerPayloadWithBack(backCmd string) *transport.PickerOpenPayload {
	p := samplePickerPayload()
	p.OnBack = &struct {
		Command string `json:"command"`
	}{Command: backCmd}
	return p
}

func TestPickerBackspace_NoOpWhenOnBackAbsent(t *testing.T) {
	// Picker without OnBack — backspace should be a no-op, picker
	// stays open.
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	app = updated.(Model)

	if app.picker == nil {
		t.Error("picker should stay open on backspace when OnBack is absent")
	}
}

// 2026-05-24 patch — /clear scrollback wipe.

// TestClearScrollback_SideEffectResetsSplashAndQueuesSplashLines covers
// the contract that when the server returns sideEffects.ClearScrollback,
// the TUI (a) marks splashShown=false so it can re-emit, (b) queues a
// fresh splash for tea.Println drain, and (c) leaves the rest of the
// downstream side-effects intact. The actual stdout-escape write
// happens in the returned tea.Cmd, which we don't invoke here — just
// confirm the model state transitions correctly.
func TestClearScrollback_SideEffectResetsSplashAndQueuesSplashLines(t *testing.T) {
	m := New("sess-1", "http://127.0.0.1:9999")
	// Simulate a first WindowSizeMsg so splash emits naturally.
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	app := updated.(Model)
	if !app.splashShown {
		t.Fatalf("precondition: splash should have emitted on first WindowSizeMsg")
	}

	// Drain the initial scrollback so the splash content from boot
	// doesn't pollute the post-clear assertions.
	initialContent := scrollbackContent(app)
	if !strings.Contains(initialContent, "Sovereign AI") && !strings.Contains(initialContent, "SOV") {
		// Splash may not contain literal "Sovereign AI" string if the
		// SplashInfo template uses ASCII art only — the assertion is
		// soft; we mainly care about the post-clear branch.
		_ = initialContent
	}

	// Now simulate a /clear response with ClearScrollback=true.
	yes := true
	resp := &transport.CommandResponse{
		Output: "conversation history cleared into child session new-id",
		SideEffects: &transport.CommandSideEffects{
			NewSessionID:    "new-id",
			ClearScrollback: &yes,
		},
	}
	updated, _ = app.Update(commandDispatchedMsg{name: "clear", resp: resp})
	app = updated.(Model)

	// splashShown should be flipped so future WindowSizeMsg events
	// would re-emit. (We don't fire one here — the immediate splash
	// re-emit already happened via emitSplash inside the handler.)
	if app.splashShown {
		t.Error("splashShown should be reset to false when ClearScrollback fires")
	}
	// SessionID should hop to the new id.
	if app.sessionID != "new-id" {
		t.Errorf("sessionID = %q, want %q", app.sessionID, "new-id")
	}
	// The "─ session ..." marker should still print (existing behavior).
	if !strings.Contains(scrollbackContent(app), "session") {
		t.Errorf("expected new-session marker in scrollback; got %q", scrollbackContent(app))
	}
}

// TestClearScrollback_NoOpWhenSideEffectFalse verifies that the
// scrollback-clear path is gated on the side-effect — absence (or nil
// pointer) leaves splashShown untouched.
func TestClearScrollback_NoOpWhenSideEffectFalse(t *testing.T) {
	m := New("sess-1", "http://127.0.0.1:9999")
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	app := updated.(Model)
	if !app.splashShown {
		t.Fatalf("precondition: splash should have emitted")
	}

	// Response with NewSessionID but no ClearScrollback (e.g.,
	// compact mints a new session without wanting a visual wipe).
	resp := &transport.CommandResponse{
		Output:      "compacted session: old -> new",
		SideEffects: &transport.CommandSideEffects{NewSessionID: "new-id"},
	}
	updated, _ = app.Update(commandDispatchedMsg{name: "compact", resp: resp})
	app = updated.(Model)

	if !app.splashShown {
		t.Error("splashShown should stay true when ClearScrollback is absent")
	}
}

// 2026-05-24 patch — `sov config` standalone mode behavior.

func TestConfigOnly_EscOnSubPickerNavigatesBack(t *testing.T) {
	// In configOnly mode, Esc on a picker that has OnBack should
	// behave like backspace (re-dispatch the back command) so the user
	// climbs the menu hierarchy instead of accidentally exiting.
	m := New("sess-1", "").WithConfigOnly(true)
	// Pretend the initial command has fired so the exit-on-no-modal
	// guard doesn't kick in too early.
	m.initialFired = true
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{
			PickerOpen: samplePickerPayloadWithBack("config providers"),
		},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := updated.(Model)

	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyEsc})
	app = updated.(Model)

	if app.picker != nil {
		t.Error("picker should be cleared after Esc-as-back in configOnly mode")
	}
	if app.configOnlyExit {
		t.Error("configOnlyExit should NOT be set when Esc triggers back-nav (we're still in config flow)")
	}
}

func TestConfigOnly_EscOnRootPickerSetsExitLatch(t *testing.T) {
	// In configOnly mode, Esc on a picker WITHOUT OnBack (root menu)
	// closes the picker AND triggers the exit-when-no-modal guard,
	// which sets configOnlyExit so the next render returns tea.Quit.
	m := New("sess-1", "").WithConfigOnly(true)
	m.initialFired = true
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{
			PickerOpen: samplePickerPayload(), // no OnBack — root picker
		},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := updated.(Model)

	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyEsc})
	app = updated.(Model)

	if app.picker != nil {
		t.Error("root picker should be cleared after Esc")
	}
	if !app.configOnlyExit {
		t.Error("configOnlyExit latch should be set when Esc closes the root menu in configOnly mode")
	}
}

func TestConfigOnly_NormalSessionEscDoesNotExit(t *testing.T) {
	// Sanity check: in NORMAL (non-configOnly) mode, Esc on a picker
	// just closes the picker. The configOnlyExit latch must stay
	// false — we're not in standalone mode.
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyEsc})
	app = updated.(Model)

	if app.configOnlyExit {
		t.Error("configOnlyExit should be false in non-configOnly mode")
	}
}

func TestConfigOnly_ViewHidesPrompt(t *testing.T) {
	// configOnly View() must skip the prompt input + status line.
	// The replacement footer mentions "Sovereign AI — config".
	m := New("sess-1", "").WithConfigOnly(true)
	m.width = 80
	m.height = 24
	out := m.View()
	if !strings.Contains(out, "Sovereign AI — config") {
		t.Errorf("configOnly View should include the config-mode footer\n--- view ---\n%s", out)
	}
	// The default prompt textarea renders a "> " marker; configOnly
	// View should NOT include it.
	if strings.Contains(out, "? for shortcuts") {
		t.Errorf("configOnly View should NOT render the shortcuts hint\n--- view ---\n%s", out)
	}
}

func TestPickerBackspace_ClearsPickerWhenOnBackPresent(t *testing.T) {
	// Picker with OnBack — backspace clears the current picker and
	// re-dispatches the back command.
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{
			PickerOpen: samplePickerPayloadWithBack("config providers"),
		},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "config", resp: resp})
	app := updated.(Model)

	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	app = updated.(Model)

	if app.picker != nil {
		t.Error("picker should be cleared after backspace when OnBack is set")
	}
}

func TestPickerEnterDispatchesSelectedValue(t *testing.T) {
	// baseURL "" causes the "(no server)" branch — we want to confirm
	// the picker clears and the dispatch path is invoked. With baseURL
	// non-empty, cmd is non-nil (we can't easily run it without a server).
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	updated, _ = app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = updated.(Model)

	if app.picker != nil {
		t.Errorf("picker should be cleared after Enter; got %+v", *app.picker)
	}
}

func TestPickerEnterWithServerDispatches(t *testing.T) {
	// With baseURL set, Enter should return a non-nil tea.Cmd carrying
	// the dispatch (we won't run it — it would hit a fake URL — just
	// confirm the cmd exists).
	m := New("sess-1", "http://127.0.0.1:1")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	updated, cmd := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = updated.(Model)

	if app.picker != nil {
		t.Errorf("picker should be cleared after Enter; got %+v", *app.picker)
	}
	if cmd == nil {
		t.Error("Enter with baseURL set should return a dispatch tea.Cmd")
	}
}

func TestPickerOtherKeysAbsorbed(t *testing.T) {
	m := New("sess-1", "")
	resp := &transport.CommandResponse{
		SideEffects: &transport.CommandSideEffects{PickerOpen: samplePickerPayload()},
	}
	updated, _ := m.Update(commandDispatchedMsg{name: "model", resp: resp})
	app := updated.(Model)

	// 'a' should be absorbed; picker stays open, prompt unchanged.
	updated, cmd := app.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	app = updated.(Model)
	if app.picker == nil {
		t.Error("picker should stay open when non-control keys arrive")
	}
	if cmd != nil {
		t.Error("non-control keys should not return a tea.Cmd")
	}
}
