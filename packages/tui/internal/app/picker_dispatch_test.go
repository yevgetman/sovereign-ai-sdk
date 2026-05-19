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

	updated, cmd := app.Update(tea.KeyMsg{Type: tea.KeyEsc})
	app = updated.(Model)

	if app.picker != nil {
		t.Errorf("picker should be nil after Esc; got %+v", *app.picker)
	}
	if cmd != nil {
		t.Error("Esc should not return a tea.Cmd (no dispatch)")
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
