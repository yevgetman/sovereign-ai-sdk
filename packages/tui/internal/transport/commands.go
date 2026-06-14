// Package transport — M10.5 generic slash-command dispatcher client.
//
// DispatchCommand calls POST /sessions/<id>/commands { name, args } and
// decodes the response envelope. The route is the TUI's bridge to the
// existing slash-command registry on the server side
// (src/commands/registry.ts): every built-in command (/help, /cost,
// /tasks, /review, /agents, /permissions, /config, /commit, /history,
// /export, /status, /context-budget, /resume, /continue, /stats, …)
// dispatches through this one client. The TUI's slash router in
// packages/tui/internal/app picks this client for any leading-slash
// input that isn't handled by a dedicated route (/compact, /skills) or
// client-side (/theme) or a known skill name.
//
// Wire shape mirrors src/server/schema.ts:
//
//	Request:  { "name": "help", "args": "" }
//	Response: {
//	  "output": "<text>",        // always present (may be empty)
//	  "error": "<msg>",          // when dispatch failed
//	  "sideEffects": {                 // optional, per-command
//	    "newSessionId": "...",         // /clear (deferred to backlog #41)
//	    "exitRequested": true,         // /quit
//	    "modelChanged": "...",         // /model <m>
//	    "effortChanged": "...",        // /effort <level>
//	    "pickerOpen": { ... },         // /model, /resume, /export no-args (M11.5)
//	    "permissionModeChanged": "…",  // /config set permissionMode (M6)
//	    "toolOutputChanged": { ... },  // /config set ui.toolOutput.* (M6)
//	    "footerChanged": true,         // /config set ui.footer.* (M6)
//	    "contextMeterChanged": { ... },// /config set ui.contextMeter.* (M6)
//	    "diffRenderChanged": true      // /config set ui.diffRender.* (M6)
//	  }
//	}

package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// CommandRequest is the POST body sent to /sessions/<id>/commands.
// The Name MUST NOT start with a leading slash — the server rejects
// "/help" with 400; pass "help" instead. The TUI strips the slash
// before constructing the request.
type CommandRequest struct {
	Name string `json:"name"`
	Args string `json:"args,omitempty"`
}

// CommandSideEffects surfaces mutations the model or command handler
// applied to the runtime that the TUI must react to.
type CommandSideEffects struct {
	// NewSessionID is set when the command mints a new child session
	// (e.g., /clear). The TUI must pivot its m.sessionID to this value
	// for subsequent POSTs. Deferred to backlog #41 in M10.5.
	NewSessionID string `json:"newSessionId,omitempty"`
	// ExitRequested signals /quit. The TUI initiates graceful shutdown.
	ExitRequested bool `json:"exitRequested,omitempty"`
	// ModelChanged set when /model <name> mutated runtime.model. The
	// TUI updates its model display.
	ModelChanged string `json:"modelChanged,omitempty"`
	// EffortChanged set when /effort <level> mutated runtime.effort. The
	// TUI updates its reasoning-depth status display. Value is one of
	// off|low|medium|high|max. Parallels ModelChanged exactly (the
	// runtime mutation IS the behavioral effect; this carries the level
	// to the Go renderer for the status chrome). Slice D / T7.
	EffortChanged string `json:"effortChanged,omitempty"`
	// PickerOpen is set when a picker-driven command (/model, /resume,
	// /export) was invoked with no args. The TUI renders an inline
	// PickerCard from this payload; on Enter the selected value is
	// dispatched as `/<command> <value>` (ADR M11.5-03). M11.5.
	PickerOpen *PickerOpenPayload `json:"pickerOpen,omitempty"`
	// ThemeChanged is set by `/theme <name>` on the server side. The
	// TS-side singleton update has no effect on the Go renderer, so
	// this side-effect carries the theme name across the process
	// boundary; the TUI applies it to m.theme + all components.
	// Backlog #46.
	ThemeChanged string `json:"themeChanged,omitempty"`
	// InputOpen is set by `/config edit <dotpath>` on free-text catalog
	// items (string / number / secret). The TUI renders an InputCard
	// from this payload; on Enter the typed value is dispatched as
	// `/<command> <value>`. 2026-05-24 (config UX rebuild).
	InputOpen *InputOpenPayload `json:"inputOpen,omitempty"`
	// VerboseChanged is set by `/config set verbose <bool>`. The TUI
	// updates its verbose-mode flag so the toolcard renderer flips
	// between the compact one-liner and the full bordered output.
	// Pointer so the absence (nil) is distinct from `false`.
	// 2026-05-24 (config UX rebuild).
	VerboseChanged *bool `json:"verboseChanged,omitempty"`
	// TaskRouterChanged carries the new preset id (or "" when routing
	// is disabled) so the status bar updates live. Pointer so absence
	// (nil) is distinct from "" (routing disabled).
	TaskRouterChanged *string `json:"taskRouterChanged,omitempty"`
	// ClearScrollback is set by `/clear` so the TUI wipes the
	// terminal's visible screen + scrollback buffer before the next
	// render. Combined with the NewSessionID hop, the user sees a
	// visually fresh session — no stale transcript bleeding through.
	// Pointer so absence is distinct from explicit `false`.
	// 2026-05-24 patch.
	ClearScrollback *bool `json:"clearScrollback,omitempty"`
	// CloseModal is set by `/config commit` / `/config discard` so the
	// TUI clears m.picker and m.inputCard regardless of any
	// previously-emitted pickerOpen / inputOpen. Critical for the
	// S-as-apply-then-save flow: dispatch the selection THEN commit,
	// where the first dispatch re-opens a parent-refresh picker and
	// the second commit must reliably close it.
	// 2026-05-24 patch.
	CloseModal *bool `json:"closeModal,omitempty"`
	// PermissionModeChanged carries the new permission mode
	// (default|plan|acceptEdits|bypass) after a live `/config set
	// permissionMode <mode>` edit. The TUI surfaces it as a status-line
	// indicator — LOUD when 'bypass' (a red chip), since bypass disables
	// every approval gate (safety). Empty/unset means no change.
	// 2026-06-14 config live-apply (M6).
	PermissionModeChanged string `json:"permissionModeChanged,omitempty"`
	// ToolOutputChanged carries a live `ui.toolOutput.*` edit. Mode is
	// "compact"|"detailed" (empty = leave unchanged); InlineLines is the
	// detailed-mode output cap (a pointer so absence is distinct from an
	// explicit 0 = header-only). Applied the same surface as
	// VerboseChanged — future tool_results pick up the new render mode.
	// 2026-06-14 config live-apply (M6).
	ToolOutputChanged *ToolOutputChange `json:"toolOutputChanged,omitempty"`
	// FooterChanged carries a live `ui.footer.*` edit. Pointer so absence
	// (nil) is distinct from an explicit `false`. Relayed to the renderer
	// flag so subsequent frames reflect the new footer visibility.
	// 2026-06-14 config live-apply (M6).
	FooterChanged *bool `json:"footerChanged,omitempty"`
	// ContextMeterChanged carries a live `ui.contextMeter.*` edit (warn /
	// danger thresholds). Pointer fields so an absent threshold is
	// distinct from an explicit 0. 2026-06-14 config live-apply (M6).
	ContextMeterChanged *ContextMeterChange `json:"contextMeterChanged,omitempty"`
	// DiffRenderChanged carries a live `ui.diffRender.*` edit. Pointer so
	// absence (nil) is distinct from an explicit `false`.
	// 2026-06-14 config live-apply (M6).
	DiffRenderChanged *bool `json:"diffRenderChanged,omitempty"`
}

// ToolOutputChange is the decoded `toolOutputChanged` side-effect. Mode
// flips the toolcard renderer (compact one-liner vs. full bordered
// output); InlineLines caps the detailed-mode output rows. Both optional
// so a partial edit (mode only, or inlineLines only) is honoured.
// 2026-06-14 config live-apply (M6).
type ToolOutputChange struct {
	Mode        string `json:"mode,omitempty"`
	InlineLines *int   `json:"inlineLines,omitempty"`
}

// ContextMeterChange is the decoded `contextMeterChanged` side-effect —
// the warn/danger percentage thresholds for the context-usage meter.
// Pointer fields so an absent threshold is distinct from an explicit 0.
// 2026-06-14 config live-apply (M6).
type ContextMeterChange struct {
	WarnAtPercent   *float64 `json:"warnAtPercent,omitempty"`
	DangerAtPercent *float64 `json:"dangerAtPercent,omitempty"`
}

// CommandResponse is the JSON envelope returned by /commands.
type CommandResponse struct {
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
	// PromptToSend carries the flattened body of a prompt-type slash
	// command (/init, /commit, every skill-sourced command). When
	// non-empty, the client should POST it as a turn — the server has
	// already done the expansion. Mirrors src/server/schema.ts's
	// optional `promptToSend` field. Empty/unset for local commands
	// (/help, /cost, etc.).
	PromptToSend string              `json:"promptToSend,omitempty"`
	SideEffects  *CommandSideEffects `json:"sideEffects,omitempty"`
}

// commandsClient — separate from the SSE consumer's long-poll client
// because /commands round trips are short (the registry calls are
// in-memory; SQLite lookups dominate). 10s timeout is generous —
// /resume's listSessions, /tasks's TaskManager query, /context-budget's
// auditContextBudget all complete in <100ms locally.
var commandsClient = &http.Client{
	Timeout: 10 * time.Second,
}

// CommandDescriptor is the TUI-renderable projection of a slash-command
// entry from src/commands/registry.ts. Mirrors the JSON shape returned
// by GET /sessions/:id/commands (backlog #45).
type CommandDescriptor struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Usage       string `json:"usage,omitempty"`
}

type commandsListResponse struct {
	Commands []CommandDescriptor `json:"commands"`
}

// GetCommands issues GET <baseURL>/sessions/<sessionID>/commands and
// returns the decoded built-in slash-command list. Mirrors GetSkills
// (M8 T6). Used at boot to populate the autocomplete popup
// dynamically — replaces the staticEntries hand-mirror on production
// runs; the static list stays as a fallback for pre-fetch / test
// scenarios. Failure is non-fatal — the autocomplete falls back to
// its compile-time list. Backlog #45.
func GetCommands(ctx context.Context, baseURL, sessionID string) ([]CommandDescriptor, error) {
	url := fmt.Sprintf("%s/sessions/%s/commands", baseURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	res, err := commandsClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get commands: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("get commands: status %d: %s", res.StatusCode, string(body))
	}
	var payload commandsListResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode commands: %w", err)
	}
	return payload.Commands, nil
}

// DispatchCommand issues POST <baseURL>/sessions/<sessionID>/commands
// with the given name + args and returns the decoded response.
// Returns a CommandResponse (which may carry an Error field describing
// a dispatch-level failure) on 200, or a Go error on transport failure
// or non-2xx HTTP status.
//
// Note the dual error channels: the TUI should render Resp.Error
// (a clean message from the command handler) differently from the
// Go error (a network / wire-format failure).
func DispatchCommand(
	ctx context.Context,
	baseURL, sessionID, name, args string,
) (*CommandResponse, error) {
	url := fmt.Sprintf("%s/sessions/%s/commands", baseURL, sessionID)
	payload, err := json.Marshal(CommandRequest{Name: name, Args: args})
	if err != nil {
		return nil, fmt.Errorf("marshal command request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := commandsClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("dispatch command: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("dispatch command: status %d: %s", res.StatusCode, string(body))
	}
	var resp CommandResponse
	if err := json.NewDecoder(res.Body).Decode(&resp); err != nil {
		return nil, fmt.Errorf("decode command response: %w", err)
	}
	return &resp, nil
}
