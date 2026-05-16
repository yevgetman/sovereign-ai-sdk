// Package transport — M8 T6 skill discovery + skill-as-slash dispatch.
//
// GetSkills hydrates the per-session skill registry from
// GET /sessions/<id>/skills (src/server/routes/skills.ts) into a Go-side
// cache the TUI consults on every leading-slash submit. When the slash
// matches a known skill name, PostSkillTurn POSTs the raw text with
// `kind: 'skill'` in the body so the server-side T5 handler runs
// `expandSkillPrompt` before saveMessage.
//
// The wire shape mirrors the route exactly: `{ skills: [{ name,
// whenToUse, description }] }`. Body, path, source, trustTier, and
// guard stay server-side — the TUI only renders + matches the three
// fields the route projects.

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

// Skill is the TUI-renderable projection of a SkillRegistry entry. Mirrors
// the JSON shape returned by GET /sessions/:id/skills.
type Skill struct {
	Name        string `json:"name"`
	WhenToUse   string `json:"whenToUse"`
	Description string `json:"description"`
}

type skillsResponse struct {
	Skills []Skill `json:"skills"`
}

// skillsClient — separate from the SSE consumer's long-poll client because
// skill discovery is a one-shot read. 5s mirrors fetchClient (the /messages
// hydration peer) — the registry build is in-memory on the server (no I/O
// past the initial boot loadSkills), so the network round trip dominates.
var skillsClient = &http.Client{
	Timeout: 5 * time.Second,
}

// GetSkills issues GET <baseURL>/sessions/<sessionID>/skills and returns
// the decoded list. Returns an error on non-2xx response or transport
// failure; the TUI logs the error and falls back to no-skill-cache
// behavior (every leading slash falls through to normal turn dispatch).
func GetSkills(ctx context.Context, baseURL, sessionID string) ([]Skill, error) {
	url := fmt.Sprintf("%s/sessions/%s/skills", baseURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	res, err := skillsClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get skills: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("get skills: status %d: %s", res.StatusCode, string(body))
	}
	var payload skillsResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode skills: %w", err)
	}
	return payload.Skills, nil
}

// PostSkillTurn issues POST <baseURL>/sessions/<sessionID>/turns with
// `{ text: <rawSlash>, kind: 'skill' }`. The server-side T5 handler at
// src/server/routes/turns.ts (lines 117-132 at writing) parses the slash,
// resolves the name against `runtime.skills.byName`, and rewrites
// `body.text` with `expandSkillPrompt(...)` before the normal
// saveMessage + query path runs.
//
// The transport helper is intentionally narrow — the TUI's submitSkillTurn
// wraps it in a tea.Cmd so the post + JSON serialization run off the
// Update goroutine.
func PostSkillTurn(ctx context.Context, baseURL, sessionID, rawText string) error {
	url := fmt.Sprintf("%s/sessions/%s/turns", baseURL, sessionID)
	payload, err := json.Marshal(map[string]string{
		"text": rawText,
		"kind": "skill",
	})
	if err != nil {
		return fmt.Errorf("marshal body: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := skillsClient.Do(req)
	if err != nil {
		return fmt.Errorf("post skill turn: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		return fmt.Errorf("post skill turn: status %d: %s", res.StatusCode, string(body))
	}
	return nil
}
