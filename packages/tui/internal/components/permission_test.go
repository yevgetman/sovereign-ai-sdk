// Permission modal tests — M5 T9.
//
// Calls Update/View directly; no teatest scaffolding needed because the
// modal is a pure tea.Model with no async commands beyond the synchronous
// PermissionSubmitMsg emitter returned by Update.

package components_test

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/components"
)

func TestPermissionModal_RendersToolNameAndChoices(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{
		RequestID: "req-1",
		Tool:      "Bash",
		Input:     "git status",
		Reason:    "",
	})
	out := p.View(80, 24)
	if !strings.Contains(out, "Bash") {
		t.Fatalf("expected tool name in output:\n%s", out)
	}
	if !strings.Contains(out, "git status") {
		t.Fatalf("expected input preview in output:\n%s", out)
	}
	if !strings.Contains(out, "[y]") {
		t.Fatalf("expected [y] choice in output:\n%s", out)
	}
	if !strings.Contains(out, "[N]") {
		t.Fatalf("expected default [N] choice in output:\n%s", out)
	}
	if !strings.Contains(out, "[a]") {
		t.Fatalf("expected [a] choice in output:\n%s", out)
	}
}

func TestPermissionModal_YApprovesAndProducesSubmitMsg(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{
		RequestID: "req-2",
		Tool:      "Bash",
		Input:     "ls",
	})
	updated, cmd := p.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	if cmd == nil {
		t.Fatal("expected a Cmd carrying the submit message")
	}
	if !updated.Done() {
		t.Fatal("expected modal to mark itself done after y")
	}
	msg := cmd()
	submit, ok := msg.(components.PermissionSubmitMsg)
	if !ok {
		t.Fatalf("expected PermissionSubmitMsg, got %T", msg)
	}
	if submit.RequestID != "req-2" {
		t.Fatalf("expected requestID 'req-2', got %q", submit.RequestID)
	}
	if !submit.Approved {
		t.Fatal("expected Approved=true for y")
	}
	if submit.Always {
		t.Fatal("expected Always=false for y")
	}
}

func TestPermissionModal_NDeniesAndProducesSubmitMsg(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{RequestID: "req-3"})
	updated, cmd := p.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	if !updated.Done() {
		t.Fatal("expected done after n")
	}
	submit := cmd().(components.PermissionSubmitMsg)
	if submit.Approved {
		t.Fatal("expected Approved=false for n")
	}
}

func TestPermissionModal_AApprovesWithAlways(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{RequestID: "req-4"})
	_, cmd := p.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	submit := cmd().(components.PermissionSubmitMsg)
	if !submit.Approved {
		t.Fatal("expected Approved=true for a")
	}
	if !submit.Always {
		t.Fatal("expected Always=true for a")
	}
}

func TestPermissionModal_EnterDefaultsToDeny(t *testing.T) {
	p := components.NewPermission(components.PermissionRequest{RequestID: "req-5"})
	_, cmd := p.Update(tea.KeyMsg{Type: tea.KeyEnter})
	submit := cmd().(components.PermissionSubmitMsg)
	if submit.Approved {
		t.Fatal("expected Enter to default to deny")
	}
}
