package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// samplePayload builds a 3-item picker payload reused across most tests.
// Mirrors the shape `/model` (no args) would emit server-side.
func samplePayload(initial int) transport.PickerOpenPayload {
	p := transport.PickerOpenPayload{
		Title:    "Select a model",
		Subtitle: "Pick the model used for the rest of this session.",
		Items: []transport.PickerItem{
			{Label: "claude-opus-4-7", Value: "claude-opus-4-7", Hint: "deepest reasoning"},
			{Label: "claude-sonnet-4-6", Value: "claude-sonnet-4-6", Hint: "balanced"},
			{Label: "claude-haiku-4-5", Value: "claude-haiku-4-5", Hint: "fastest"},
		},
		Initial: initial,
	}
	p.OnSelect.Command = "model"
	return p
}

func TestPickerCard_InitialSelection(t *testing.T) {
	card := NewPickerCard(samplePayload(2), theme.Dark())
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should resolve on a non-empty payload")
	}
	if value != "claude-haiku-4-5" {
		t.Errorf("initial selection: got %q want %q", value, "claude-haiku-4-5")
	}
}

func TestPickerCard_InitialClamped(t *testing.T) {
	// Initial=99 on a 3-item list should clamp to index 2 (last).
	card := NewPickerCard(samplePayload(99), theme.Dark())
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should resolve on a non-empty payload")
	}
	if value != "claude-haiku-4-5" {
		t.Errorf("clamped initial selection: got %q want %q", value, "claude-haiku-4-5")
	}
}

func TestPickerCard_MoveDown_Clamp(t *testing.T) {
	// At the end of the list, MoveDown should be a no-op.
	card := NewPickerCard(samplePayload(2), theme.Dark())
	card.MoveDown()
	card.MoveDown()
	card.MoveDown()
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should still resolve after MoveDown clamp")
	}
	if value != "claude-haiku-4-5" {
		t.Errorf("MoveDown clamp: got %q want %q", value, "claude-haiku-4-5")
	}
}

func TestPickerCard_MoveUp_Clamp(t *testing.T) {
	// At the start of the list, MoveUp should be a no-op.
	card := NewPickerCard(samplePayload(0), theme.Dark())
	card.MoveUp()
	card.MoveUp()
	card.MoveUp()
	value, ok := card.Selected()
	if !ok {
		t.Fatal("Selected() should still resolve after MoveUp clamp")
	}
	if value != "claude-opus-4-7" {
		t.Errorf("MoveUp clamp: got %q want %q", value, "claude-opus-4-7")
	}
}

func TestPickerCard_View_ContainsAllItems(t *testing.T) {
	card := NewPickerCard(samplePayload(0), theme.Dark())
	out := card.View(80)
	for _, label := range []string{"claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"} {
		if !strings.Contains(out, label) {
			t.Errorf("View(80) missing label %q in output:\n%s", label, out)
		}
	}
}

func TestPickerCard_View_HighlightsSelected(t *testing.T) {
	card := NewPickerCard(samplePayload(1), theme.Dark())
	out := card.View(80)
	// The `›` selection prefix should appear exactly once.
	count := strings.Count(out, "›")
	if count != 1 {
		t.Errorf("expected exactly one `›` prefix in View(80) output, got %d:\n%s", count, out)
	}
	// The selected row's label should appear adjacent to the prefix.
	// We can't assert byte ordering of lipgloss escapes reliably, but we
	// can confirm the prefix and the selected label both appear.
	if !strings.Contains(out, "claude-sonnet-4-6") {
		t.Errorf("View(80) missing selected label `claude-sonnet-4-6` in:\n%s", out)
	}
}

func TestPickerCard_View_Footer(t *testing.T) {
	card := NewPickerCard(samplePayload(0), theme.Dark())
	out := card.View(80)
	for _, word := range []string{"navigate", "confirm", "cancel"} {
		if !strings.Contains(out, word) {
			t.Errorf("View(80) footer missing %q in:\n%s", word, out)
		}
	}
}

func TestPickerCard_Selected_EmptyItems(t *testing.T) {
	empty := transport.PickerOpenPayload{
		Title: "Empty picker",
		Items: nil,
	}
	empty.OnSelect.Command = "model"
	card := NewPickerCard(empty, theme.Dark())
	value, ok := card.Selected()
	if ok {
		t.Errorf("Selected() on empty payload should return ok=false; got value=%q", value)
	}
	if value != "" {
		t.Errorf("Selected() value on empty payload should be empty string; got %q", value)
	}
}

func TestPickerCard_Command(t *testing.T) {
	card := NewPickerCard(samplePayload(0), theme.Dark())
	if cmd := card.Command(); cmd != "model" {
		t.Errorf("Command(): got %q want %q", cmd, "model")
	}
}

// 2026-05-24 patch — back-navigation tests. OnBack() returns the
// dispatcher command for backspace navigation; empty string when the
// payload has no OnBack (root menu / non-hierarchical picker).

func TestPickerCard_OnBack_EmptyWhenAbsent(t *testing.T) {
	// samplePayload doesn't set OnBack (mirrors /model, /resume,
	// /export, /theme — non-hierarchical pickers).
	card := NewPickerCard(samplePayload(0), theme.Dark())
	if back := card.OnBack(); back != "" {
		t.Errorf("OnBack() with no payload OnBack: got %q want empty", back)
	}
}

func TestPickerCard_OnBack_ReturnsPayloadCommand(t *testing.T) {
	payload := samplePayload(0)
	payload.OnBack = &struct {
		Command string `json:"command"`
	}{Command: "config providers"}
	card := NewPickerCard(payload, theme.Dark())
	if back := card.OnBack(); back != "config providers" {
		t.Errorf("OnBack(): got %q want %q", back, "config providers")
	}
}

func TestPickerCard_View_FooterMentionsBackspaceWhenOnBackSet(t *testing.T) {
	payload := samplePayload(0)
	payload.OnBack = &struct {
		Command string `json:"command"`
	}{Command: "config"}
	view := NewPickerCard(payload, theme.Dark()).View(60)
	if !strings.Contains(view, "backspace") {
		t.Errorf("View(): footer missing backspace hint when OnBack is set\n--- view ---\n%s", view)
	}
}

func TestPickerCard_View_FooterOmitsBackspaceWhenOnBackAbsent(t *testing.T) {
	view := NewPickerCard(samplePayload(0), theme.Dark()).View(60)
	if strings.Contains(view, "backspace") {
		t.Errorf("View(): footer mentions backspace when OnBack is absent\n--- view ---\n%s", view)
	}
}

// 2026-05-24 config UX rebuild — extended fields tests.

// configSamplePayload builds a 3-item payload with ValueColumn + Badge
// set on each row, mirroring the shape `/config task-routing` would
// emit server-side. Used by the value-column and badge rendering tests.
func configSamplePayload() transport.PickerOpenPayload {
	p := transport.PickerOpenPayload{
		Title: "config / task routing",
		Items: []transport.PickerItem{
			{
				Label:       "enabled",
				Value:       "taskRouting.enabled",
				ValueColumn: "false",
				Badge:       "reload",
			},
			{
				Label:       "delegator.model",
				Value:       "taskRouting.delegator.model",
				ValueColumn: "claude-sonnet-4-6",
				Badge:       "reload",
			},
			{
				Label:       "lanes.cheap-task.provider",
				Value:       "taskRouting.lanes.cheap-task.provider",
				ValueColumn: "anthropic",
				Badge:       "live",
			},
		},
	}
	p.OnSelect.Command = "config edit"
	return p
}

// TestPickerCard_BackwardsCompatibleLayout verifies that the M11.5
// rendering (label + optional hint) is byte-identical when neither
// ValueColumn nor Badge is set on any item. This protects /model,
// /resume, /export, /theme from visual regression.
func TestPickerCard_BackwardsCompatibleLayout(t *testing.T) {
	card := NewPickerCard(samplePayload(0), theme.Dark())
	out := card.View(80)
	// Hints should still render (M11.5 behavior).
	for _, hint := range []string{"deepest reasoning", "balanced", "fastest"} {
		if !strings.Contains(out, hint) {
			t.Errorf("View(80) baseline layout missing hint %q in:\n%s", hint, out)
		}
	}
	// No value-column / badge artifacts should appear.
	for _, leak := range []string{"✓ live", "✓ applied", "⤴ other process", "⟳ restart"} {
		if strings.Contains(out, leak) {
			t.Errorf("View(80) baseline layout unexpectedly contains %q in:\n%s", leak, out)
		}
	}
}

func TestPickerCard_ValueColumnRendered(t *testing.T) {
	card := NewPickerCard(configSamplePayload(), theme.Dark())
	out := card.View(120)
	for _, value := range []string{"false", "claude-sonnet-4-6", "anthropic"} {
		if !strings.Contains(out, value) {
			t.Errorf("View(120) wide layout missing value column %q in:\n%s", value, out)
		}
	}
}

func TestPickerCard_BadgeLiveRenders(t *testing.T) {
	card := NewPickerCard(configSamplePayload(), theme.Dark())
	out := card.View(120)
	if !strings.Contains(out, "✓ live") {
		t.Errorf("expected '✓ live' badge for live items in:\n%s", out)
	}
}

func TestPickerCard_BadgeReloadRenders(t *testing.T) {
	// 2026-06-14 config live-apply — 'reload' is a between-turns reload
	// that still applies THIS session, so it reads as the green "applied"
	// affordance (not the old amber "next session"). See applyScope.ts.
	card := NewPickerCard(configSamplePayload(), theme.Dark())
	out := card.View(120)
	if !strings.Contains(out, "✓ applied") {
		t.Errorf("expected '✓ applied' badge for reload items in:\n%s", out)
	}
}

// 2026-06-14 config live-apply — the two amber scopes ('other', 'restart')
// render distinct glyph+label pills so the user sees why a save didn't
// apply to this session.
func TestPickerCard_BadgeOtherProcessRenders(t *testing.T) {
	payload := transport.PickerOpenPayload{
		Title: "config / gateway",
		Items: []transport.PickerItem{
			{Label: "port", Value: "gateway.port", ValueColumn: "8766", Badge: "other"},
		},
	}
	payload.OnSelect.Command = "config edit"
	card := NewPickerCard(payload, theme.Dark())
	out := card.View(120)
	if !strings.Contains(out, "⤴ other process") {
		t.Errorf("expected '⤴ other process' badge for 'other' items in:\n%s", out)
	}
}

func TestPickerCard_BadgeRestartRenders(t *testing.T) {
	payload := transport.PickerOpenPayload{
		Title: "config / debug",
		Items: []transport.PickerItem{
			{Label: "enabled", Value: "debugMode.enabled", ValueColumn: "false", Badge: "restart"},
		},
	}
	payload.OnSelect.Command = "config edit"
	card := NewPickerCard(payload, theme.Dark())
	out := card.View(120)
	if !strings.Contains(out, "⟳ restart") {
		t.Errorf("expected '⟳ restart' badge for 'restart' items in:\n%s", out)
	}
}

func TestPickerCard_UnknownBadgeRendersNothing(t *testing.T) {
	// Items with Badge="" or Badge=<unknown> render no badge text.
	payload := transport.PickerOpenPayload{
		Title: "test",
		Items: []transport.PickerItem{
			{Label: "a", Value: "a", ValueColumn: "x", Badge: "mystery"},
			{Label: "b", Value: "b", ValueColumn: "y", Badge: ""},
		},
	}
	payload.OnSelect.Command = "noop"
	card := NewPickerCard(payload, theme.Dark())
	out := card.View(80)
	for _, leak := range []string{"✓ live", "✓ applied", "⤴ other process", "⟳ restart", "mystery"} {
		if strings.Contains(out, leak) {
			t.Errorf("View(80) unexpectedly contains %q for unknown badge in:\n%s", leak, out)
		}
	}
	// Value column should still appear.
	for _, value := range []string{"x", "y"} {
		if !strings.Contains(out, value) {
			t.Errorf("expected value column %q to render alongside unknown badge in:\n%s", value, out)
		}
	}
}

// TestPickerCard_SecretDisplayPassesThrough verifies the Go side just
// renders whatever ValueColumn contains — masking ("••••••••") is done
// server-side in the catalog handler. The contract is "display
// verbatim, server is the source of truth for masking".
func TestPickerCard_SecretDisplayPassesThrough(t *testing.T) {
	payload := transport.PickerOpenPayload{
		Title: "providers / anthropic",
		Items: []transport.PickerItem{
			{Label: "apiKey", Value: "providers.anthropic.apiKey", ValueColumn: "••••••••", Badge: "reload"},
			{Label: "apiKey-unset", Value: "providers.openai.apiKey", ValueColumn: "(unset)", Badge: "reload"},
		},
	}
	payload.OnSelect.Command = "config edit"
	card := NewPickerCard(payload, theme.Dark())
	out := card.View(120)
	if !strings.Contains(out, "••••••••") {
		t.Errorf("expected masked dots to pass through View(120) verbatim; got:\n%s", out)
	}
	if !strings.Contains(out, "(unset)") {
		t.Errorf("expected '(unset)' marker to pass through View(120) verbatim; got:\n%s", out)
	}
}

// TestPickerCard_LabelAlignment verifies labels are padded so the value
// columns line up. Verifies the layout-math contract: across multiple
// items, every value column starts at the same horizontal position
// (label column width + gap).
func TestPickerCard_LabelAlignment(t *testing.T) {
	payload := transport.PickerOpenPayload{
		Title: "alignment",
		Items: []transport.PickerItem{
			{Label: "a", Value: "a", ValueColumn: "v1"},
			{Label: "much-longer-key", Value: "b", ValueColumn: "v2"},
		},
	}
	payload.OnSelect.Command = "noop"
	card := NewPickerCard(payload, theme.Dark())
	out := card.View(80)
	// Both value columns should appear. We can't pin exact column
	// offsets reliably (lipgloss escape codes), but we can pin that
	// both values are present and the layout didn't drop either.
	if !strings.Contains(out, "v1") {
		t.Errorf("expected 'v1' value column in:\n%s", out)
	}
	if !strings.Contains(out, "v2") {
		t.Errorf("expected 'v2' value column in:\n%s", out)
	}
}
