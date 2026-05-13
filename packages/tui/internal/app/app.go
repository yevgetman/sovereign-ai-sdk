// Package app — Bubble Tea root model for the Phase 16.1 TUI.
//
// M2: bare scaffold. Renders transcript + prompt + status. SSE consumer is
// wired but the URL may point at a stub server during smoke. ESC quits.
//
// M3 expands: text_delta events append to transcript; tool_result events
// produce placeholder cards; prompt ENTER submits a POST /turns.

package app

import (
	"context"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/components"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// sseMsg is emitted into the Bubble Tea event loop for each Envelope.
type sseMsg struct{ env transport.Envelope }

// sseDoneMsg signals the SSE consumer has finished (turn ended or error).
type sseDoneMsg struct{ err error }

type Model struct {
	keys       keyMap
	transcript components.Transcript
	prompt     components.Prompt
	statusLine components.StatusLine
	sessionID  string
	streamURL  string
	width      int
	height     int
	ctx        context.Context
	cancel     context.CancelFunc
}

func New(sessionID, streamURL string) Model {
	cwd, _ := os.Getwd()
	ctx, cancel := context.WithCancel(context.Background())
	st := components.NewStatusLine()
	st.Cwd = cwd
	return Model{
		keys:       defaultKeys(),
		transcript: components.NewTranscript(),
		prompt:     components.NewPrompt(),
		statusLine: st,
		sessionID:  sessionID,
		streamURL:  streamURL,
		ctx:        ctx,
		cancel:     cancel,
	}
}

func (m Model) Init() tea.Cmd {
	if m.streamURL == "" {
		return nil
	}
	return m.connectSSE
}

// connectSSE returns a tea.Cmd that opens the SSE stream and feeds Envelopes
// back into the Bubble Tea loop as sseMsg until it ends (or errors).
func (m Model) connectSSE() tea.Msg {
	events, errs := transport.Consume(m.ctx, m.streamURL)
	for env := range events {
		// Send each event back into the loop as a tea.Msg by returning;
		// however, tea.Cmd returns a single Msg. We need a Cmd that emits
		// many. The pattern is: a Cmd that polls one event and recursively
		// reschedules itself.
		return sseMsg{env: env}
	}
	if err := <-errs; err != nil {
		return sseDoneMsg{err: err}
	}
	return sseDoneMsg{err: nil}
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
		var cmd tea.Cmd
		m.prompt, cmd = m.prompt.Update(msg)
		return m, cmd
	case sseMsg:
		m.handleEvent(msg.env)
		return m, m.connectSSE
	case sseDoneMsg:
		m.transcript.AppendLine("[stream closed]")
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
		m.transcript.AppendLine(td.Text)
	case "turn_complete":
		m.transcript.AppendLine("[turn complete]")
	}
}

func (m Model) View() string {
	if m.height == 0 {
		return ""
	}
	return m.transcript.View() + "\n" + m.prompt.View() + "\n" + m.statusLine.View()
}
