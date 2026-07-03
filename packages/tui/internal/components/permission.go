// Package components — Permission: modal prompt for canUseTool ask mode.
//
// Renders a centered yellow-bordered box when a permission_request SSE
// event arrives. Replaces the M3 warning-only handler in app.go.
//
// Visual style matches src/ui/modal.ts (terminalRepl's modal) for parity
// between surfaces. M5-04: yellow border, tool name, input preview
// (truncated to one line), three choices [y]/[N]/[a].
//
// Key bindings (M5-04):
//
//	y / Y    → approve (allow once)
//	n / N    → deny
//	a / A    → approve + always (memory choice; M5 keeps it client-side
//	           only — restart loses it, matching pre-Phase-13 terminalRepl)
//	Enter    → deny (the default; matches the highlighted [N])
//	Esc      → deny

package components

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/style"
)

// PermissionRequest is the modal's input — extracted from a
// permission_request SSE event by the caller.
type PermissionRequest struct {
	RequestID string
	Tool      string
	Input     string
	Reason    string
}

// PermissionSubmitMsg is emitted into the Bubble Tea event loop when the
// user makes a choice. The parent (app.go) catches it and POSTs to
// /sessions/:id/approvals/:requestID.
type PermissionSubmitMsg struct {
	RequestID string
	Approved  bool
	Always    bool
}

// Permission is a one-shot modal. Once Done() returns true, the parent
// must stop routing keys to it and replace it with nil.
type Permission struct {
	req  PermissionRequest
	done bool
}

// NewPermission constructs a fresh modal bound to a single request.
func NewPermission(req PermissionRequest) Permission {
	return Permission{req: req}
}

// Done reports whether the user has made a choice. The parent uses this
// to gate further key dispatch and to clear the modal after the submit
// message is handled.
func (p Permission) Done() bool { return p.done }

// Update handles a single key event. Returns the next state and a Cmd
// that, when run, produces a PermissionSubmitMsg.
func (p Permission) Update(msg tea.Msg) (Permission, tea.Cmd) {
	keyMsg, ok := msg.(tea.KeyMsg)
	if !ok {
		return p, nil
	}
	switch keyMsg.Type {
	case tea.KeyEnter:
		return p.deny()
	case tea.KeyEsc:
		return p.deny()
	}
	switch keyMsg.String() {
	case "y", "Y":
		p.done = true
		return p, p.emit(true, false)
	case "n", "N":
		return p.deny()
	case "a", "A":
		p.done = true
		return p, p.emit(true, true)
	}
	return p, nil
}

func (p Permission) deny() (Permission, tea.Cmd) {
	p.done = true
	return p, p.emit(false, false)
}

func (p Permission) emit(approved, always bool) tea.Cmd {
	requestID := p.req.RequestID
	return func() tea.Msg {
		return PermissionSubmitMsg{
			RequestID: requestID,
			Approved:  approved,
			Always:    always,
		}
	}
}

// View renders the modal centered within (width, height). When width is
// zero the parent hasn't received a WindowSizeMsg yet — render nothing
// rather than emit unbounded output.
func (p Permission) View(width, height int) string {
	if width == 0 {
		return ""
	}
	// Truncate input preview to a single line, 60 chars max. Newlines
	// would break the box layout, so flatten them to spaces.
	preview := p.req.Input
	if len(preview) > style.S.Permission.PreviewMax {
		preview = preview[:style.S.Permission.PreviewMax-3] + "..."
	}
	preview = strings.ReplaceAll(preview, "\n", " ")

	// M9 T11: backlog #29 — lipgloss Style is value-typed; .Copy() is a
	// deprecated identity helper. Direct field-chain assignments already
	// produce new values, so the .Copy() calls were redundant.
	yellow := lipgloss.NewStyle().Foreground(lipgloss.Color(style.S.Brand.PermissionYellow))
	bold := yellow.Bold(true)
	dim := lipgloss.NewStyle().Foreground(lipgloss.Color(style.S.Brand.PermissionGrey))
	defaultChoice := bold.Underline(true)

	lines := []string{
		bold.Render("permission required"),
		"",
		dim.Render("tool   ") + lipgloss.NewStyle().Bold(true).Render(p.req.Tool),
		dim.Render("input  ") + preview,
	}
	if p.req.Reason != "" {
		lines = append(lines, dim.Render("reason ")+dim.Render(p.req.Reason))
	}
	lines = append(lines,
		"",
		fmt.Sprintf("%s %s   %s %s   %s %s",
			yellow.Render("[y]"), dim.Render("allow"),
			defaultChoice.Render("[N]"), dim.Render("deny"),
			yellow.Render("[a]"), dim.Render("always"),
		),
	)

	box := lipgloss.NewStyle().
		Border(style.S.Card.Border).
		BorderForeground(lipgloss.Color(style.S.Brand.PermissionYellow)).
		Padding(style.S.Card.PaddingV, style.S.Permission.PaddingH).
		Render(strings.Join(lines, "\n"))

	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}
