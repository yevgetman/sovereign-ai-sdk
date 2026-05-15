// Package app — Bubble Tea root model for the Phase 16.1 TUI.
//
// M2: bare scaffold. Renders transcript + prompt + status. SSE consumer is
// wired but the URL may point at a stub server during smoke. ESC quits.
//
// M3 expands: text_delta events append to transcript; tool_result events
// produce placeholder cards; prompt ENTER submits a POST /turns.

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/components"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// sseMsg is emitted into the Bubble Tea event loop for each Envelope.
type sseMsg struct{ env transport.Envelope }

// sseDoneMsg signals the SSE consumer has finished (turn ended or error).
type sseDoneMsg struct{ err error }

// turnSubmitErrMsg is emitted when a POST /turns request fails. M3 prints a
// dim error line to the transcript; M4+ surfaces structured errors.
type turnSubmitErrMsg struct{ err error }

// messagesFetchedMsg carries the result of the M4 hydration fetch.
// Init batches this alongside the SSE consumer so resume flows show the
// prior conversation immediately. err is non-nil on transport failure or
// non-2xx; the Update handler surfaces it as a dim transcript line and
// continues (does not crash the TUI).
type messagesFetchedMsg struct {
	messages []transport.StoredMessage
	err      error
}

// compactCompleteMsg carries the synchronous /compact route's response.
// activeSessionID is the new child session id (subsequent POST /turns
// route to it). summary is the compaction summary text — currently
// unrendered (the M6 marker is intentionally minimal); M9 will use it
// for the styled "compaction summary" card. Keeping it on the message
// avoids re-decoding the response body when M9 lands.
//
// noOp (backlog #36) is true when the server short-circuited because
// the entire history fit within the tail budget. The TUI must suppress
// both the session-id pivot AND the "new session" marker — otherwise
// the user sees "─ compacted — new session <prefix>" where the prefix
// is the SAME id they had before. Render a friendlier marker instead.
type compactCompleteMsg struct {
	activeSessionID string
	summary         string
	noOp            bool
}

// compactErrorMsg surfaces a /compact route failure (non-2xx or
// transport error) into the transcript as a dim error line. The
// session id is NOT pivoted on failure — the user can retry.
type compactErrorMsg struct {
	err error
}

type Model struct {
	keys            keyMap
	transcript      components.Transcript
	prompt          components.Prompt
	statusLine      components.StatusLine
	sessionID       string
	baseURL         string
	width           int
	height          int
	ctx             context.Context
	cancel          context.CancelFunc
	events          <-chan transport.Envelope
	errs            <-chan error
	thinkingPending bool
	permission      *components.Permission // M5 T9: active approval modal; nil when not visible
}

// New constructs the App model. baseURL is the server origin (scheme +
// host + port, no trailing slash) — the model derives both the SSE
// stream URL and the /messages backlog URL from it. Pass an empty
// baseURL to skip both network operations (used by render-only tests).
func New(sessionID, baseURL string) Model {
	cwd, _ := os.Getwd()
	ctx, cancel := context.WithCancel(context.Background())
	st := components.NewStatusLine()
	st.Cwd = cwd
	m := Model{
		keys:       defaultKeys(),
		transcript: components.NewTranscript(),
		prompt:     components.NewPrompt(),
		statusLine: st,
		sessionID:  sessionID,
		baseURL:    baseURL,
		ctx:        ctx,
		cancel:     cancel,
	}
	if baseURL != "" {
		streamURL := fmt.Sprintf("%s/sessions/%s/events", baseURL, sessionID)
		m.events, m.errs = transport.Consume(ctx, streamURL)
	}
	return m
}

func (m Model) Init() tea.Cmd {
	if m.baseURL == "" {
		return nil
	}
	// Fire the backlog hydration in parallel with the SSE subscription.
	// On a resume the user sees prior turns immediately; on a fresh
	// session the fetch returns zero messages and the handler is a no-op.
	if m.events == nil {
		return m.fetchMessagesCmd()
	}
	return tea.Batch(m.fetchMessagesCmd(), m.waitEvent)
}

// fetchMessagesCmd issues the GET /sessions/<id>/messages backlog fetch
// off the Update goroutine. The result lands as a messagesFetchedMsg.
func (m Model) fetchMessagesCmd() tea.Cmd {
	return func() tea.Msg {
		msgs, err := transport.FetchMessages(m.ctx, m.baseURL, m.sessionID)
		return messagesFetchedMsg{messages: msgs, err: err}
	}
}

// waitEvent blocks until the next SSE event arrives (or the stream ends).
// Idiomatic Bubble Tea pattern for an unbounded event source: the Cmd reads
// from a long-lived channel and reschedules itself after each delivery.
func (m Model) waitEvent() tea.Msg {
	if m.events == nil {
		return sseDoneMsg{}
	}
	select {
	case <-m.ctx.Done():
		return sseDoneMsg{err: m.ctx.Err()}
	case env, ok := <-m.events:
		if !ok {
			// channel closed — drain errs (single value) if present.
			select {
			case err := <-m.errs:
				return sseDoneMsg{err: err}
			default:
				return sseDoneMsg{}
			}
		}
		return sseMsg{env: env}
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		const statusH = 1
		const promptH = 2
		m.transcript.SetSize(msg.Width, msg.Height-statusH-promptH)
		m.prompt.SetWidth(msg.Width)
		m.statusLine.SetWidth(msg.Width)
		return m, nil
	case tea.KeyMsg:
		// M5 T9: when a permission modal is active, route ALL keys to it
		// (including Esc and Enter — the modal treats both as "deny"). The
		// modal sets done=true after the user's choice, after which it is
		// cleared by the PermissionSubmitMsg branch below.
		if m.permission != nil && !m.permission.Done() {
			updated, cmd := m.permission.Update(msg)
			m.permission = &updated
			return m, cmd
		}
		if key := msg.String(); key == "esc" || key == "ctrl+c" {
			m.cancel()
			return m, tea.Quit
		}
		if msg.Type == tea.KeyEnter {
			text := strings.TrimSpace(m.prompt.Value())
			if text == "" {
				return m, nil
			}
			// M6 T6: intercept the `/compact` slash command BEFORE the
			// POST /turns dispatch. The user-visible echo + clear still
			// happens (so the input doesn't sit in the prompt) but we
			// route to the synchronous /compact HTTP verb instead of
			// sending the literal string as a turn. Render the dim
			// placeholder so the user sees feedback during the
			// same-provider summarize wait (can take several seconds);
			// the compactCompleteMsg / compactErrorMsg branches replace
			// it with the result marker.
			if text == "/compact" {
				m.transcript.AppendLine("» " + text)
				m.prompt.Clear()
				dimStyle := lipgloss.NewStyle().
					Foreground(lipgloss.Color("#6e7681")).
					Italic(true)
				m.transcript.AppendLine(dimStyle.Render("[compacting…]"))
				return m, m.compactCmd()
			}
			m.transcript.AppendLine("» " + text)
			m.prompt.Clear()
			// Dim placeholder so the user sees feedback during the 1-3s
			// network wait before the first text_delta arrives. The first
			// response event clears it (see clearThinkingIfPending).
			dimStyle := lipgloss.NewStyle().
				Foreground(lipgloss.Color("#6e7681")).
				Italic(true)
			m.transcript.AppendLine(dimStyle.Render("…thinking"))
			m.thinkingPending = true
			return m, m.submitTurn(text)
		}
		var cmd tea.Cmd
		m.prompt, cmd = m.prompt.Update(msg)
		return m, cmd
	case sseMsg:
		m.handleEvent(msg.env)
		return m, m.waitEvent
	case sseDoneMsg:
		// The server closes the SSE stream and disposes the per-session bus
		// after every turn_complete / turn_error (events.ts:63-74) by M3
		// design. Without reconnect the TUI subscribes once in New() and
		// never sees events from any subsequent turn — the user submits a
		// turn (POST returns 202) but nothing ever renders. Re-Consume on
		// a fresh subscription against the CURRENT m.sessionID (which may
		// have pivoted via /compact or compaction_complete). Skip when:
		//   - app context is cancelled (user pressed ESC / Ctrl+C)
		//   - baseURL is empty (render-only test fixtures with no server)
		// The dim "[stream closed]" marker that this branch used to emit
		// was meaningful when the design was single-turn-per-launch; with
		// reconnect it would be noise after every turn so we drop it.
		if m.ctx.Err() != nil || m.baseURL == "" {
			return m, nil
		}
		streamURL := fmt.Sprintf("%s/sessions/%s/events", m.baseURL, m.sessionID)
		m.events, m.errs = transport.Consume(m.ctx, streamURL)
		return m, m.waitEvent
	case turnSubmitErrMsg:
		m.transcript.AppendLine(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#e06c75")).
				Render(fmt.Sprintf("submit error: %v", msg.err)),
		)
		return m, nil
	case messagesFetchedMsg:
		if msg.err != nil {
			// Don't crash — surface a dim line and let the live SSE stream
			// continue. Resume flows will look empty but the next user turn
			// still works end-to-end.
			m.transcript.AppendLine(
				lipgloss.NewStyle().
					Foreground(lipgloss.Color("#6e7681")).
					Italic(true).
					Render(fmt.Sprintf("could not load prior messages: %v", msg.err)),
			)
			return m, nil
		}
		// Render each prior message's text blocks in transcript order.
		// User input gets the same "» " prefix as the live ENTER handler
		// so prior and live turns look visually identical. tool_use /
		// tool_result historical rendering is deferred to M7 when
		// trajectory capture lands richer hydration.
		for _, sm := range msg.messages {
			for _, block := range sm.Content {
				if block.Type != "text" || block.Text == "" {
					continue
				}
				switch sm.Role {
				case "user":
					m.transcript.AppendLine("» " + block.Text)
				case "assistant":
					m.transcript.AppendLine(block.Text)
				}
			}
		}
		return m, nil
	case components.PermissionSubmitMsg:
		// M5 T9: user's choice has been captured; clear the modal and POST
		// the decision back to the server. The runtime's serverAsk awaits
		// /sessions/:id/approvals/:requestId and resumes the paused turn.
		m.permission = nil
		return m, m.postApproval(msg)
	case compactCompleteMsg:
		// M6 T6: pop the placeholder and pivot the session id. Subsequent
		// POST /turns hit the new child session — the SSE stream stays on
		// the parent (the bus is keyed on parent and continues to surface
		// post-compaction events under the parent id; the Compactor's wire
		// contract puts the child as `activeSessionId` rather than reseating
		// the SSE subscription).
		m.transcript.RemoveLastLine()
		dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681"))
		// Backlog #36: when the server returns noOp=true the entire history
		// fit within the tail budget — there was nothing to summarize. Skip
		// the session-id pivot (activeSessionID === parent id anyway) and
		// render a friendlier marker so the user understands the call
		// succeeded but no compaction took place.
		if msg.noOp {
			m.transcript.AppendLine(dim.Render("─ nothing to compact (history already fits)"))
			return m, nil
		}
		m.sessionID = msg.activeSessionID
		// Truncate the new id to 8 chars in the user marker — full uuid is
		// noise; the prefix is enough to disambiguate. M9 owns the styled
		// "compaction summary" card that will render the full id + summary.
		m.transcript.AppendLine(dim.Render(fmt.Sprintf("─ compacted — new session %s", shortSessionID(msg.activeSessionID))))
		return m, nil
	case compactErrorMsg:
		// M6 T6: pop the placeholder and surface the failure. The session
		// id stays on the parent — the user can retry. Use the same red
		// style as turnSubmitErrMsg for visual consistency.
		m.transcript.RemoveLastLine()
		m.transcript.AppendLine(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#e06c75")).
				Render(fmt.Sprintf("compact failed: %v", msg.err)),
		)
		return m, nil
	}
	var cmd tea.Cmd
	m.transcript, cmd = m.transcript.Update(msg)
	return m, cmd
}

func (m *Model) handleEvent(env transport.Envelope) {
	switch env.Type {
	case "text_delta":
		td, err := transport.DecodeTextDelta(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		m.transcript.AppendLine(td.Text)
	case "thinking_delta":
		td, err := transport.DecodeThinkingDelta(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		m.transcript.AppendLine(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#6e7681")).
				Italic(true).
				Render(td.Text),
		)
	case "tool_use_start":
		tus, err := transport.DecodeToolUseStart(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		m.transcript.AppendLine(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#6e7681")).
				Render(fmt.Sprintf("-> %s starting...", tus.Tool)),
		)
	case "tool_result":
		tr, err := transport.DecodeToolResult(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		hint := tr.RenderHint
		if hint == "" {
			hint = "text"
		}
		card := components.ToolCard{
			Tool:       tr.Tool,
			RenderHint: hint,
			Summary:    fmt.Sprintf("rendered as %s", hint),
		}
		m.transcript.AppendLine(card.View(m.width))
	case "permission_request":
		// M5 T9: push the interactive permission modal. The modal renders
		// as a centered yellow box; key dispatch is routed to it in
		// Update() until the user picks y/n/a (or Enter/Esc default to
		// deny). The choice produces a PermissionSubmitMsg, which the
		// Update handler POSTs to /sessions/:id/approvals/:requestId.
		pr, err := transport.DecodePermissionRequest(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		modal := components.NewPermission(components.PermissionRequest{
			RequestID: pr.RequestID,
			Tool:      pr.Tool,
			Input:     fmt.Sprintf("%s", pr.Input),
			Reason:    pr.Reason,
		})
		m.permission = &modal
	case "turn_error":
		te, err := transport.DecodeTurnError(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		errStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#f7768e")).
			Bold(true)
		m.transcript.AppendLine(errStyle.Render("⚠ turn error: " + te.Error))
		if !te.Recoverable {
			m.transcript.AppendLine(errStyle.Render("  (non-recoverable)"))
		}
	case "turn_complete":
		tc, err := transport.DecodeTurnComplete(env.Raw)
		if err != nil {
			// Schema parse failed — still surface SOMETHING so the user
			// knows the turn ended. Don't regress on the pre-fix marker.
			m.clearThinkingIfPending()
			m.transcript.AppendLine("[turn complete]")
			return
		}
		m.clearThinkingIfPending()
		dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681"))
		if tc.FinishReason == "" || tc.FinishReason == "end_turn" {
			m.transcript.AppendLine(dim.Render("─ turn complete"))
		} else {
			m.transcript.AppendLine(dim.Render("─ turn complete (" + tc.FinishReason + ")"))
		}
	case "compaction_complete":
		// M6 T6: T3 (proactive) and T4 (overflow recovery) publish this
		// event mid-turn when the session id hops to a new child. The
		// SSE subscription stays on the parent (the bus is keyed on
		// parent), but subsequent POST /turns + approval requests must
		// route to the new child id — pivot m.sessionID immediately.
		// The marker is intentionally minimal; M9 owns the styled
		// "compaction summary" card.
		cc, err := transport.DecodeCompactionComplete(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		m.sessionID = cc.ActiveSessionID
		dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681"))
		m.transcript.AppendLine(dim.Render(fmt.Sprintf(
			"─ auto-compacted — %d→%d tokens — new session %s",
			cc.EstimatedBeforeTokens, cc.EstimatedAfterTokens, shortSessionID(cc.ActiveSessionID),
		)))
	}
}

// clearThinkingIfPending removes the "…thinking" placeholder appended by the
// ENTER handler. Called from every event handler that produces visible
// output for a turn (text_delta, thinking_delta, tool_use_start, tool_result,
// turn_error, turn_complete). The placeholder is always the most recent line
// because the SSE stream is serialized into the Update goroutine, so we can
// safely pop the tail.
func (m *Model) clearThinkingIfPending() {
	if !m.thinkingPending {
		return
	}
	m.transcript.RemoveLastLine()
	m.thinkingPending = false
}

// shortSessionID returns the first 8 chars of a session id, or the full
// id if shorter. Production session ids are UUIDs so the truncation
// always fires; the guard is defense against a future short-id format.
func shortSessionID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func (m Model) View() string {
	if m.height == 0 {
		return ""
	}
	// M5 T9: when a permission modal is active, overlay it over the whole
	// frame (Place centers the box inside width/height). v1 suppresses the
	// base layer to keep rendering simple; later milestones may composite
	// both so the user retains some peripheral context while choosing.
	if m.permission != nil && !m.permission.Done() {
		return m.permission.View(m.width, m.height)
	}
	return m.transcript.View() + "\n" + m.prompt.View() + "\n" + m.statusLine.View()
}

// postApproval POSTs the user's permission decision to
// /sessions/<id>/approvals/<requestId>. The server's approvalQueue
// resolves the matching pending request, which unblocks serverAsk and
// resumes the paused turn. Errors surface as turnSubmitErrMsg so they
// land in the transcript rather than silently dropping; the runtime will
// emit a turn_error if the approval failed to register.
func (m Model) postApproval(submit components.PermissionSubmitMsg) tea.Cmd {
	return func() tea.Msg {
		body, err := json.Marshal(map[string]any{
			"approved": submit.Approved,
			"always":   submit.Always,
		})
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		url := fmt.Sprintf("%s/sessions/%s/approvals/%s", m.baseURL, m.sessionID, submit.RequestID)
		req, err := http.NewRequestWithContext(m.ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return turnSubmitErrMsg{err: fmt.Errorf("approval POST returned %d", resp.StatusCode)}
		}
		return nil
	}
}

// compactCmd POSTs to /sessions/<currentId>/compact (M6 T6). The
// transport client owns the 60s timeout (compactClient in http.go) so
// the same-provider summarize wait doesn't block the Update goroutine.
// The returned Cmd produces compactCompleteMsg on success or
// compactErrorMsg on transport / non-2xx failure. Cancellation: uses
// m.ctx so ESC/quit aborts the in-flight POST cleanly (the route's
// c.req.raw.signal forwards client disconnect into runtime.compact()).
func (m Model) compactCmd() tea.Cmd {
	return func() tea.Msg {
		resp, err := transport.PostCompact(m.ctx, m.baseURL, m.sessionID)
		if err != nil {
			return compactErrorMsg{err: err}
		}
		return compactCompleteMsg{
			activeSessionID: resp.ActiveSessionID,
			summary:         resp.Summary,
			noOp:            resp.NoOp,
		}
	}
}

// submitTurn POSTs the user's text to /sessions/<id>/turns. The URL is
// derived from baseURL. The returned Cmd runs off the Update goroutine;
// any error is delivered as a turnSubmitErrMsg so the transcript can
// show it without blocking.
func (m Model) submitTurn(text string) tea.Cmd {
	return func() tea.Msg {
		turnsURL := fmt.Sprintf("%s/sessions/%s/turns", m.baseURL, m.sessionID)
		payload, err := json.Marshal(map[string]string{"text": text})
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		req, err := http.NewRequestWithContext(m.ctx, http.MethodPost, turnsURL, bytes.NewReader(payload))
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return turnSubmitErrMsg{err: err}
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return turnSubmitErrMsg{err: fmt.Errorf("server returned %d", resp.StatusCode)}
		}
		// Successful 202 — events will arrive via the SSE consumer.
		return nil
	}
}
