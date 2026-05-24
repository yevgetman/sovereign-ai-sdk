package transport

import (
	"encoding/json"
	"testing"
)

// TestInputOpenPayload_DecodeMinimum verifies the minimum-viable wire
// shape (only `title` + `onSubmit`) decodes correctly. Optional fields
// must be zero-valued; Masked must be false.
func TestInputOpenPayload_DecodeMinimum(t *testing.T) {
	raw := []byte(`{"title":"maxTurns","onSubmit":{"command":"config set maxTurns"}}`)
	var got InputOpenPayload
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Title != "maxTurns" {
		t.Errorf("Title = %q, want %q", got.Title, "maxTurns")
	}
	if got.OnSubmit.Command != "config set maxTurns" {
		t.Errorf("OnSubmit.Command = %q, want %q", got.OnSubmit.Command, "config set maxTurns")
	}
	if got.Subtitle != "" {
		t.Errorf("Subtitle = %q, want empty", got.Subtitle)
	}
	if got.Initial != "" {
		t.Errorf("Initial = %q, want empty", got.Initial)
	}
	if got.Placeholder != "" {
		t.Errorf("Placeholder = %q, want empty", got.Placeholder)
	}
	if got.Masked {
		t.Errorf("Masked = true, want false")
	}
}

// TestInputOpenPayload_DecodeFull verifies all optional fields are
// captured. Masked=true is the secret-input case (API keys).
func TestInputOpenPayload_DecodeFull(t *testing.T) {
	raw := []byte(`{
		"title": "providers.anthropic.apiKey",
		"subtitle": "Stored at ~/.harness/config.json",
		"initial": "",
		"placeholder": "sk-ant-...",
		"masked": true,
		"onSubmit": {"command": "config set providers.anthropic.apiKey"}
	}`)
	var got InputOpenPayload
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Title != "providers.anthropic.apiKey" {
		t.Errorf("Title = %q", got.Title)
	}
	if got.Subtitle != "Stored at ~/.harness/config.json" {
		t.Errorf("Subtitle = %q", got.Subtitle)
	}
	if got.Placeholder != "sk-ant-..." {
		t.Errorf("Placeholder = %q", got.Placeholder)
	}
	if !got.Masked {
		t.Errorf("Masked = false, want true")
	}
	if got.OnSubmit.Command != "config set providers.anthropic.apiKey" {
		t.Errorf("OnSubmit.Command = %q", got.OnSubmit.Command)
	}
}

// TestPickerItem_BackwardsCompatible verifies the M11.5 baseline shape
// still decodes without ValueColumn/Badge — the existing /model,
// /resume, /export, /theme paths must keep working.
func TestPickerItem_BackwardsCompatible(t *testing.T) {
	raw := []byte(`{"label":"dark","value":"dark","hint":"Catppuccin Mocha"}`)
	var got PickerItem
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Label != "dark" || got.Value != "dark" || got.Hint != "Catppuccin Mocha" {
		t.Errorf("baseline fields incorrect: %+v", got)
	}
	if got.ValueColumn != "" {
		t.Errorf("ValueColumn = %q, want empty (omitted in baseline shape)", got.ValueColumn)
	}
	if got.Badge != "" {
		t.Errorf("Badge = %q, want empty (omitted in baseline shape)", got.Badge)
	}
}

// TestPickerItem_DecodeExtended verifies the new ValueColumn + Badge
// fields decode. Badge values are server-validated against {"live",
// "reload"}; the Go side stores whatever it receives and the renderer
// only acts on those two known values.
func TestPickerItem_DecodeExtended(t *testing.T) {
	raw := []byte(`{
		"label": "taskRouting.enabled",
		"value": "taskRouting.enabled",
		"valueColumn": "false",
		"badge": "reload"
	}`)
	var got PickerItem
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ValueColumn != "false" {
		t.Errorf("ValueColumn = %q, want \"false\"", got.ValueColumn)
	}
	if got.Badge != "reload" {
		t.Errorf("Badge = %q, want \"reload\"", got.Badge)
	}
}
