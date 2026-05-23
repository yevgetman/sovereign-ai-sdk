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
