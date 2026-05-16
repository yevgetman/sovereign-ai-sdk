// Package transport — tests for the M8 T6 skill discovery client.
//
// Pins the wire shape against src/server/routes/skills.ts:60-66 — a regression
// that drops `name`, `whenToUse`, or `description` (or rearranges the JSON
// keys) lands here as a decode failure or zero-value field rather than as a
// silently broken /skillname interception in the live TUI.

package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetSkills_ReturnsList(t *testing.T) {
	const sessionID = "abc-123"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sessions/"+sessionID+"/skills" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"skills": []map[string]string{
				{"name": "greet", "whenToUse": "when user types /greet", "description": "Greets"},
				{"name": "review", "whenToUse": "when user asks for review", "description": ""},
			},
		})
	}))
	defer srv.Close()

	skills, err := GetSkills(context.Background(), srv.URL, sessionID)
	if err != nil {
		t.Fatalf("GetSkills: %v", err)
	}
	if len(skills) != 2 {
		t.Fatalf("expected 2 skills, got %d", len(skills))
	}
	if skills[0].Name != "greet" {
		t.Fatalf("expected first skill name greet, got %s", skills[0].Name)
	}
	if skills[0].WhenToUse != "when user types /greet" {
		t.Fatalf("expected first whenToUse, got %q", skills[0].WhenToUse)
	}
	if skills[0].Description != "Greets" {
		t.Fatalf("expected first description, got %q", skills[0].Description)
	}
	if skills[1].Name != "review" {
		t.Fatalf("expected second skill name review, got %s", skills[1].Name)
	}
}

// TestGetSkills_HandlesError pins the non-2xx error contract — the client
// must surface a non-nil error so the TUI can fall back to no-skill-cache
// behavior (every slash falls through to normal turn dispatch) rather than
// silently treating a server failure as "zero skills registered".
func TestGetSkills_HandlesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"mock failure"}`, http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := GetSkills(context.Background(), srv.URL, "abc-123")
	if err == nil {
		t.Fatal("expected error on 500, got nil")
	}
}

// TestPostSkillTurn_SendsKindSkill pins the M8 T6 dispatch contract — the
// /skillname intercept must POST the raw slash text with `kind: 'skill'`
// in the JSON body so the server-side T5 handler runs `expandSkillPrompt`
// before saveMessage. A regression that drops `kind` would silently send
// the literal /greet Alice as a turn (the model sees the slash) rather
// than the expanded skill body the user expects.
func TestPostSkillTurn_SendsKindSkill(t *testing.T) {
	const sessionID = "abc-123"
	var (
		capturedPath string
		capturedBody map[string]string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "wrong method", http.StatusMethodNotAllowed)
			return
		}
		capturedPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	if err := PostSkillTurn(context.Background(), srv.URL, sessionID, "/greet Alice"); err != nil {
		t.Fatalf("PostSkillTurn: %v", err)
	}
	want := "/sessions/" + sessionID + "/turns"
	if capturedPath != want {
		t.Fatalf("path = %q, want %q", capturedPath, want)
	}
	if capturedBody["text"] != "/greet Alice" {
		t.Fatalf("body.text = %q, want '/greet Alice'", capturedBody["text"])
	}
	if capturedBody["kind"] != "skill" {
		t.Fatalf("body.kind = %q, want 'skill'", capturedBody["kind"])
	}
}
