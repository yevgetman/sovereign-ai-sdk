// Package transport — HTTP client helpers complementing the SSE consumer.
//
// FetchMessages hydrates the session's prior message backlog on Init().
// The Go TUI calls this once before subscribing to the SSE stream so
// resume flows render immediately. Fresh sessions return an empty array.

package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// StoredContentBlock is the wire shape of a single content block in
// stored messages. Mirrors the TS shape: { type: string, text?: string,
// tool_use_id?: string, content?: ... }. Only `text` is decoded fully;
// other types are passed through unrendered for now.
type StoredContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// StoredMessage is a single persisted message: role + content blocks.
type StoredMessage struct {
	Role    string               `json:"role"`
	Content []StoredContentBlock `json:"content"`
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
	res, err := http.DefaultClient.Do(req)
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
