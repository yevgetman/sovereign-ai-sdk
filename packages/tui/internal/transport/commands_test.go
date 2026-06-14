// Package transport — M10.5 dispatcher client tests.
//
// Pins the wire shape against src/server/schema.ts's CommandResponseSchema.
// Regression on field-name drift (output → out, sideEffects → side, etc.)
// lands here as a decode-zero-value rather than as a silently-broken
// slash command in the live TUI.

package transport

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDispatchCommand_HappyPath(t *testing.T) {
	const sessionID = "test-session-id"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sessions/"+sessionID+"/commands" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "wrong method", http.StatusMethodNotAllowed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req CommandRequest
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Name != "help" {
			http.Error(w, "expected help", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(CommandResponse{
			Output: "help text content",
		})
	}))
	defer srv.Close()

	resp, err := DispatchCommand(context.Background(), srv.URL, sessionID, "help", "")
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.Output != "help text content" {
		t.Errorf("output = %q, want %q", resp.Output, "help text content")
	}
	if resp.Error != "" {
		t.Errorf("unexpected error field: %q", resp.Error)
	}
	if resp.SideEffects != nil {
		t.Errorf("unexpected sideEffects: %+v", resp.SideEffects)
	}
}

func TestDispatchCommand_ErrorEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(CommandResponse{
			Output: "",
			Error:  "unknown command: /healp",
		})
	}))
	defer srv.Close()

	resp, err := DispatchCommand(context.Background(), srv.URL, "abc-123", "healp", "")
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.Output != "" {
		t.Errorf("output = %q, want empty", resp.Output)
	}
	if resp.Error == "" {
		t.Errorf("expected error field, got empty")
	}
	if !strings.Contains(resp.Error, "unknown command") {
		t.Errorf("error = %q, want to contain 'unknown command'", resp.Error)
	}
}

func TestDispatchCommand_SideEffects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(CommandResponse{
			Output: "model set to claude-sonnet-4-6",
			SideEffects: &CommandSideEffects{
				ModelChanged: "claude-sonnet-4-6",
			},
		})
	}))
	defer srv.Close()

	resp, err := DispatchCommand(
		context.Background(), srv.URL, "abc-123", "model", "claude-sonnet-4-6",
	)
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.SideEffects == nil {
		t.Fatalf("expected sideEffects, got nil")
	}
	if resp.SideEffects.ModelChanged != "claude-sonnet-4-6" {
		t.Errorf("modelChanged = %q, want claude-sonnet-4-6", resp.SideEffects.ModelChanged)
	}
}

// TestDispatchCommand_EffortChangedSideEffect verifies the effortChanged
// side-effect (Slice D / T7) decodes from the wire. Mirrors the
// modelChanged branch above — /effort <level> mutates runtime.effort
// server-side and carries the new level here so the TUI status chrome
// updates. Hand-rolled JSON pins the wire field name (`effortChanged`,
// matching src/server/schema.ts + src/server/commandContext.ts).
func TestDispatchCommand_EffortChangedSideEffect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(
			`{"output":"effort set to high (reasoning depth for this session).",` +
				`"sideEffects":{"effortChanged":"high"}}`,
		))
	}))
	defer srv.Close()

	resp, err := DispatchCommand(
		context.Background(), srv.URL, "abc-123", "effort", "high",
	)
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.SideEffects == nil {
		t.Fatalf("expected sideEffects, got nil")
	}
	if resp.SideEffects.EffortChanged != "high" {
		t.Errorf("effortChanged = %q, want high", resp.SideEffects.EffortChanged)
	}
}

// TestDispatchCommand_InputOpenSideEffect verifies that the new
// inputOpen side-effect (2026-05-24 config UX rebuild) decodes
// correctly. This is the wire branch /config edit takes for
// string/number/secret editor kinds.
func TestDispatchCommand_InputOpenSideEffect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"output": "",
			"sideEffects": {
				"inputOpen": {
					"title": "providers.anthropic.apiKey",
					"subtitle": "Stored at ~/.harness/config.json",
					"initial": "",
					"placeholder": "sk-ant-...",
					"masked": true,
					"onSubmit": {"command": "config set providers.anthropic.apiKey"}
				}
			}
		}`))
	}))
	defer srv.Close()

	resp, err := DispatchCommand(
		context.Background(), srv.URL, "abc-123", "config", "edit providers.anthropic.apiKey",
	)
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.SideEffects == nil || resp.SideEffects.InputOpen == nil {
		t.Fatalf("expected sideEffects.inputOpen, got %+v", resp.SideEffects)
	}
	got := resp.SideEffects.InputOpen
	if got.Title != "providers.anthropic.apiKey" {
		t.Errorf("Title = %q", got.Title)
	}
	if !got.Masked {
		t.Errorf("Masked = false, want true (secret field)")
	}
	if got.OnSubmit.Command != "config set providers.anthropic.apiKey" {
		t.Errorf("OnSubmit.Command = %q", got.OnSubmit.Command)
	}
}

// TestDispatchCommand_VerboseChangedSideEffect verifies the new
// verboseChanged side-effect decodes. Pointer type lets nil be
// distinct from `false` (the absence vs. an explicit set-false).
func TestDispatchCommand_VerboseChangedSideEffect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(
			`{"output":"saved","sideEffects":{"verboseChanged":true}}`,
		))
	}))
	defer srv.Close()

	resp, err := DispatchCommand(
		context.Background(), srv.URL, "abc-123", "config", "set verbose true",
	)
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.SideEffects == nil || resp.SideEffects.VerboseChanged == nil {
		t.Fatalf("expected sideEffects.verboseChanged, got %+v", resp.SideEffects)
	}
	if !*resp.SideEffects.VerboseChanged {
		t.Errorf("VerboseChanged = false, want true")
	}
}

// TestDispatchCommand_M6SideEffects verifies the 2026-06-14 config
// live-apply chrome/render side-effects decode from the wire. Hand-rolled
// JSON pins the field names (permissionModeChanged, toolOutputChanged,
// footerChanged, contextMeterChanged, diffRenderChanged) against
// CommandSideEffectsSchema in src/server/schema.ts. Drift lands here as a
// decode-zero-value rather than a silently-dead live config edit.
func TestDispatchCommand_M6SideEffects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"output": "saved — permissionMode applied to this session",
			"sideEffects": {
				"permissionModeChanged": "bypass",
				"toolOutputChanged": {"mode": "detailed", "inlineLines": 25},
				"footerChanged": false,
				"contextMeterChanged": {"warnAtPercent": 70, "dangerAtPercent": 90},
				"diffRenderChanged": true
			}
		}`))
	}))
	defer srv.Close()

	resp, err := DispatchCommand(
		context.Background(), srv.URL, "abc-123", "config", "set permissionMode bypass",
	)
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.SideEffects == nil {
		t.Fatalf("expected sideEffects, got nil")
	}
	se := resp.SideEffects
	if se.PermissionModeChanged != "bypass" {
		t.Errorf("permissionModeChanged = %q, want bypass", se.PermissionModeChanged)
	}
	if se.ToolOutputChanged == nil {
		t.Fatalf("expected toolOutputChanged, got nil")
	}
	if se.ToolOutputChanged.Mode != "detailed" {
		t.Errorf("toolOutputChanged.Mode = %q, want detailed", se.ToolOutputChanged.Mode)
	}
	if se.ToolOutputChanged.InlineLines == nil || *se.ToolOutputChanged.InlineLines != 25 {
		t.Errorf("toolOutputChanged.InlineLines = %v, want 25", se.ToolOutputChanged.InlineLines)
	}
	if se.FooterChanged == nil || *se.FooterChanged {
		t.Errorf("footerChanged = %v, want explicit false", se.FooterChanged)
	}
	if se.ContextMeterChanged == nil {
		t.Fatalf("expected contextMeterChanged, got nil")
	}
	if se.ContextMeterChanged.WarnAtPercent == nil || *se.ContextMeterChanged.WarnAtPercent != 70 {
		t.Errorf("contextMeterChanged.WarnAtPercent = %v, want 70", se.ContextMeterChanged.WarnAtPercent)
	}
	if se.ContextMeterChanged.DangerAtPercent == nil || *se.ContextMeterChanged.DangerAtPercent != 90 {
		t.Errorf("contextMeterChanged.DangerAtPercent = %v, want 90", se.ContextMeterChanged.DangerAtPercent)
	}
	if se.DiffRenderChanged == nil || !*se.DiffRenderChanged {
		t.Errorf("diffRenderChanged = %v, want true", se.DiffRenderChanged)
	}
}

// TestDispatchCommand_M6PartialToolOutput verifies a mode-only edit
// (no inlineLines) decodes with a nil InlineLines so the apply path
// leaves the current cap unchanged.
func TestDispatchCommand_M6PartialToolOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(
			`{"output":"saved","sideEffects":{"toolOutputChanged":{"mode":"compact"}}}`,
		))
	}))
	defer srv.Close()

	resp, err := DispatchCommand(
		context.Background(), srv.URL, "abc-123", "config", "set ui.toolOutput.mode compact",
	)
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.SideEffects == nil || resp.SideEffects.ToolOutputChanged == nil {
		t.Fatalf("expected toolOutputChanged, got %+v", resp.SideEffects)
	}
	if resp.SideEffects.ToolOutputChanged.Mode != "compact" {
		t.Errorf("Mode = %q, want compact", resp.SideEffects.ToolOutputChanged.Mode)
	}
	if resp.SideEffects.ToolOutputChanged.InlineLines != nil {
		t.Errorf("InlineLines should be nil for a mode-only edit; got %v",
			*resp.SideEffects.ToolOutputChanged.InlineLines)
	}
}

// TestDispatchCommand_InputOpenBadge verifies the apply-scope badge token
// on the inputOpen side-effect decodes (2026-06-14 config live-apply).
func TestDispatchCommand_InputOpenBadge(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"output": "",
			"sideEffects": {
				"inputOpen": {
					"title": "defaultModel",
					"onSubmit": {"command": "config set defaultModel"},
					"badge": "reload"
				}
			}
		}`))
	}))
	defer srv.Close()

	resp, err := DispatchCommand(
		context.Background(), srv.URL, "abc-123", "config", "edit defaultModel",
	)
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.SideEffects == nil || resp.SideEffects.InputOpen == nil {
		t.Fatalf("expected inputOpen, got %+v", resp.SideEffects)
	}
	if resp.SideEffects.InputOpen.Badge != "reload" {
		t.Errorf("InputOpen.Badge = %q, want reload", resp.SideEffects.InputOpen.Badge)
	}
}

func TestDispatchCommand_PromptToSend(t *testing.T) {
	// Backlog: prompt-type slash commands (/init, /commit, every
	// skill-sourced command) return a structured `promptToSend` field
	// alongside `output`. The TUI must decode this so it can auto-fire
	// the expanded prompt as a turn — mirroring what `sov drive`
	// already does (src/cli/driveCommand.ts:475).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Hand-rolled JSON pins the wire field name (`promptToSend`,
		// not `prompt_to_send` or any other casing).
		_, _ = w.Write([]byte(
			`{"output":"Prompt-type slash command. Sending …",` +
				`"promptToSend":"The body of the expanded prompt."}`,
		))
	}))
	defer srv.Close()

	resp, err := DispatchCommand(context.Background(), srv.URL, "abc-123", "init", "")
	if err != nil {
		t.Fatalf("DispatchCommand: %v", err)
	}
	if resp.PromptToSend != "The body of the expanded prompt." {
		t.Errorf("PromptToSend = %q, want %q",
			resp.PromptToSend, "The body of the expanded prompt.")
	}
}

func TestDispatchCommand_Non2xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := DispatchCommand(context.Background(), srv.URL, "abc-123", "help", "")
	if err == nil {
		t.Fatalf("expected error for 404, got nil")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error = %q, want to contain '404'", err.Error())
	}
}

func TestDispatchCommand_NetworkFailureReturnsError(t *testing.T) {
	// Point at a closed port — connection refused.
	_, err := DispatchCommand(
		context.Background(), "http://127.0.0.1:1", "abc-123", "help", "",
	)
	if err == nil {
		t.Fatalf("expected network error, got nil")
	}
}

func TestDispatchCommand_RequestShape(t *testing.T) {
	// Verify the wire shape: name + args, no leading slash.
	captured := make(chan CommandRequest, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req CommandRequest
		_ = json.Unmarshal(body, &req)
		captured <- req
		_ = json.NewEncoder(w).Encode(CommandResponse{Output: "ok"})
	}))
	defer srv.Close()

	_, _ = DispatchCommand(
		context.Background(), srv.URL, "abc-123", "model", "claude-sonnet-4-6",
	)
	req := <-captured
	if req.Name != "model" {
		t.Errorf("name = %q, want model", req.Name)
	}
	if req.Args != "claude-sonnet-4-6" {
		t.Errorf("args = %q, want claude-sonnet-4-6", req.Args)
	}
}
