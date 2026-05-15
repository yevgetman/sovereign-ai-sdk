// Package transport — HTTP client helpers complementing the SSE consumer.
//
// FetchMessages hydrates the session's prior message backlog on Init().
// The Go TUI calls this once before subscribing to the SSE stream so
// resume flows render immediately. Fresh sessions return an empty array.
//
// PostCompact (M6 T6) drives the explicit `/compact` slash command —
// synchronous POST to /sessions/:id/compact that returns the new
// activeSessionId (the same payload the proactive + overflow paths
// publish via the `compaction_complete` SSE event). 60s timeout because
// the same-provider summarize path can take several seconds; matches
// the wait users tolerate from the terminalRepl `/compact` command.

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

// StoredContentBlock is the wire shape of a single content block in
// stored messages. Mirrors the TS shape: { type: string, text?: string,
// tool_use_id?: string, content?: ... }. Only `text` is decoded fully;
// other types are passed through unrendered for now.
type StoredContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// StoredMessage is a single persisted message: role + content blocks.
type StoredMessage struct {
	Role    string               `json:"role"`
	Content []StoredContentBlock `json:"content"`
}

var fetchClient = &http.Client{
	Timeout: 5 * time.Second,
}

type messagesResponse struct {
	Messages []StoredMessage `json:"messages"`
}

// FetchMessages issues GET <baseURL>/sessions/<sessionID>/messages and
// returns the decoded backlog. Returns an error on non-2xx response or
// transport failure; an empty backlog is `(nil, nil)` (200 with []).
func FetchMessages(ctx context.Context, baseURL, sessionID string) ([]StoredMessage, error) {
	url := fmt.Sprintf("%s/sessions/%s/messages", baseURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	res, err := fetchClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get messages: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("get messages: status %d: %s", res.StatusCode, string(body))
	}
	var payload messagesResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode messages: %w", err)
	}
	return payload.Messages, nil
}

// CompactResponse mirrors the JSON shape returned by
// POST /sessions/:id/compact (src/server/routes/compact.ts:70-77).
// ActiveSessionID is the new child id the TUI must pivot subsequent
// turn POSTs onto. ParentSessionID echoes the input id (for caller
// convenience — the TUI dispatch handler can pivot without remembering
// which URL it called). Token estimates expose the compaction's effect
// for footer rendering. UsedAuxiliary tells the TUI whether the
// fallback auxiliary client was consulted (M6-06 same-provider path is
// the default; UsedAuxiliary=true only when the same-provider summarize
// call failed and the auxiliary route succeeded).
type CompactResponse struct {
	ActiveSessionID       string `json:"activeSessionId"`
	ParentSessionID       string `json:"parentSessionId"`
	Summary               string `json:"summary"`
	EstimatedBeforeTokens int    `json:"estimatedBeforeTokens"`
	EstimatedAfterTokens  int    `json:"estimatedAfterTokens"`
	UsedAuxiliary         bool   `json:"usedAuxiliary"`
}

// compactClient — separate from fetchClient because the same-provider
// summarize path can take several seconds (sometimes the auxiliary
// fallback adds another network round trip). 60s matches the wait
// users tolerate from the terminalRepl `/compact` command, which runs
// inline against the same `runtime.compact` primitive.
var compactClient = &http.Client{
	Timeout: 60 * time.Second,
}

// PostCompact issues POST <baseURL>/sessions/<sessionID>/compact and
// returns the decoded CompactResponse. Returns an error on non-2xx
// response or transport failure. The route is synchronous — the
// response IS the notification of completion (no SSE event is
// published on this path; T3/T4 publish `compaction_complete` only for
// proactive + overflow recovery hops where the bus subscriber needs to
// learn about the session-id pivot mid-turn).
func PostCompact(ctx context.Context, baseURL, sessionID string) (*CompactResponse, error) {
	url := fmt.Sprintf("%s/sessions/%s/compact", baseURL, sessionID)
	// Empty JSON body — the route reads :id from the URL and the
	// session history from sessionDb. Sending `{}` rather than nil
	// keeps the Content-Type header meaningful and matches the
	// approval POST shape (app.go:postApproval) for symmetry.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := compactClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post compact: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("post compact: status %d: %s", res.StatusCode, string(body))
	}
	var payload CompactResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode compact: %w", err)
	}
	return &payload, nil
}
