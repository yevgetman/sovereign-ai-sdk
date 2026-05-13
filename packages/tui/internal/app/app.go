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

type Model struct {
	keys            keyMap
	transcript      components.Transcript
	prompt          components.Prompt
	statusLine      components.StatusLine
	sessionID       string
	streamURL       string
	width           int
	height          int
	ctx             context.Context
	cancel          context.CancelFunc
	events          <-chan transport.Envelope
	errs            <-chan error
	thinkingPending bool
}

func New(sessionID, streamURL string) Model {
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
		streamURL:  streamURL,
		ctx:        ctx,
		cancel:     cancel,
	}
	if streamURL != "" {
		m.events, m.errs = transport.Consume(ctx, streamURL)
	}
	return m
}

func (m Model) Init() tea.Cmd {
	if m.events == nil {
		return nil
	}
	return m.waitEvent
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
		if key := msg.String(); key == "esc" || key == "ctrl+c" {
			m.cancel()
			return m, tea.Quit
		}
		if msg.Type == tea.KeyEnter {
			text := strings.TrimSpace(m.prompt.Value())
			if text == "" {
				return m, nil
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
		m.transcript.AppendLine("[stream closed]")
		return m, nil
	case turnSubmitErrMsg:
		m.transcript.AppendLine(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#e06c75")).
				Render(fmt.Sprintf("submit error: %v", msg.err)),
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
		// M3 has no approval UI. Surface a visible warning so a user
		// who somehow lands in `default`/`ask` mode sees what's wrong
		// instead of staring at "…thinking" forever. The TS runtime's
		// permission cascade should resolve to `bypass` for any user
		// with permissionMode=bypass in ~/.harness/config.json, so this
		// branch is defense-in-depth.
		pr, err := transport.DecodePermissionRequest(env.Raw)
		if err != nil {
			return
		}
		m.clearThinkingIfPending()
		warnStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#e5c07b")).
			Bold(true)
		m.transcript.AppendLine(warnStyle.Render("⚠ permission requested: " + pr.Tool))
		m.transcript.AppendLine(warnStyle.Render("  M3 has no approval UI; the turn will hang. ESC to abort."))
		m.transcript.AppendLine(warnStyle.Render("  Fix: set permissionMode=bypass in ~/.harness/config.json, or add an allow rule."))
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

func (m Model) View() string {
	if m.height == 0 {
		return ""
	}
	return m.transcript.View() + "\n" + m.prompt.View() + "\n" + m.statusLine.View()
}

// submitTurn POSTs the user's text to /sessions/<id>/turns. The URL is
// derived from streamURL by swapping the /events suffix for /turns. The
// returned Cmd runs off the Update goroutine; any error is delivered as
// a turnSubmitErrMsg so the transcript can show it without blocking.
func (m Model) submitTurn(text string) tea.Cmd {
	return func() tea.Msg {
		turnsURL := strings.Replace(
			m.streamURL,
			fmt.Sprintf("/sessions/%s/events", m.sessionID),
			fmt.Sprintf("/sessions/%s/turns", m.sessionID),
			1,
		)
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
