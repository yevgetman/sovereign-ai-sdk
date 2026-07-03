// Package app — M10.5 generic slash-command dispatcher routing.
//
// parseGenericSlashCommand parses a leading-slash input into (name, args)
// for dispatch via transport.DispatchCommand. The ENTER handler runs
// this AFTER all dedicated branches (/theme, /compact, /expand, /skills
// <verb>, /skillname) so only un-handled slashes route here. Anything
// that fails this parser (no slash, just a slash, etc.) falls through
// to the normal turn POST.
//
// dispatchCommandCmd is the tea.Cmd builder that POSTs through the
// transport client off the Update goroutine. The Update handler for
// commandDispatchedMsg renders output + applies sideEffects.

package app

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

// commandDispatchedMsg surfaces the /commands route response (or a
// transport-level error) back into the Update loop.
type commandDispatchedMsg struct {
	name string
	resp *transport.CommandResponse
	err  error
}

// parseGenericSlashCommand returns (name, args, true) when input is a
// leading-slash command shape like "/help" or "/model claude-sonnet-4-6".
// Returns ok=false for empty input, missing slash, "/" alone (no name),
// or names that contain whitespace (only the FIRST token is the name —
// the rest becomes args). Names are returned WITHOUT the leading slash
// because the server route's CommandRequestSchema rejects slash-prefixed
// names (the slash is on the wire, not in the JSON).
func parseGenericSlashCommand(input string) (name string, args string, ok bool) {
	trimmed := strings.TrimSpace(input)
	if !strings.HasPrefix(trimmed, "/") {
		return "", "", false
	}
	rest := strings.TrimSpace(trimmed[1:])
	if rest == "" {
		return "", "", false
	}
	parts := strings.SplitN(rest, " ", 2)
	name = strings.TrimSpace(parts[0])
	if name == "" {
		return "", "", false
	}
	if len(parts) == 2 {
		args = strings.TrimSpace(parts[1])
	}
	return name, args, true
}

// dispatchCommandCmd POSTs the parsed slash command to the server's
// /commands route and returns a commandDispatchedMsg with the result
// (or transport error). Off-loaded to a tea.Cmd so the network call
// doesn't block the Update goroutine.
//
// Uses a 10s overall context — generous for /resume's listSessions
// query and /tasks's TaskManager scan; tighter than the transport
// client's own 10s so we exit cleanly on cancellation.
func dispatchCommandCmd(baseURL, sessionID, name, args string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resp, err := transport.DispatchCommand(ctx, baseURL, sessionID, name, args)
		return commandDispatchedMsg{name: name, resp: resp, err: err}
	}
}
