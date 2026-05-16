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
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/components"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
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

// skillsFetchedMsg carries the result of the M8 T6 skill cache hydration.
// On success the model populates `skills` so the leading-slash intercept
// can match user input against known skill names. On failure the
// message carries err; the TUI logs a dim line and falls back to
// no-skill-cache behavior (every slash falls through to normal turn
// dispatch). This mirrors the messagesFetchedMsg contract for
// hydration fetch failures — degrade gracefully rather than crash.
type skillsFetchedMsg struct {
	skills []transport.Skill
	err    error
}

// focusTarget tracks which sub-component receives non-modal key events.
// Default focusTranscript routes keys to the prompt input + transcript.
// focusDiffView routes j/k to the most-recent DiffView for hunk nav.
// focusAutocomplete (added in T8) routes Tab/Esc/Up/Down to the popup.
type focusTarget int

const (
	focusTranscript focusTarget = iota
	focusDiffView
	focusAutocomplete
)

type Model struct {
	keys             keyMap
	transcript       components.Transcript
	prompt           components.Prompt
	statusLine       components.StatusLine
	sessionID        string
	baseURL          string
	width            int
	height           int
	ctx              context.Context
	cancel           context.CancelFunc
	events           <-chan transport.Envelope
	errs             <-chan error
	thinkingPending  bool
	permission       *components.Permission // M5 T9: active approval modal; nil when not visible
	skills           []transport.Skill      // M8 T6: skill cache populated by the GET /skills hydration
	completedBlocks  []CompletedBlock       // M8 T6: ring buffer of tool_result blocks for /expand re-render
	theme            theme.Theme            // M9 T1: active color/style palette (constructor-injected per ADR M9-01)
	mostRecentDiff   *components.DiffView   // M9 T5: points to the diff in the latest FileEdit/FileWrite tool_result; Ctrl+] focuses
	focus            focusTarget            // M9 T5: routing target for j/k/Esc when not in modal
	goodbyeSummary   *transport.SessionSummary // M9 T7: non-nil after session_summary event; View renders the card instead
	autocomplete     components.SlashAutocomplete // M9 T8: popup shown when prompt starts with /
	harnessHome      string                     // M9.5 T3: $HARNESS_HOME path for theme persistence reads/writes
	pendingThemeErr  error                      // M9.5 T3: surfaced as a dim marker on first WindowSizeMsg
	pendingThemeName string                     // M9.5 T3: theme name from config used in the dim marker text
	stallBadge       *components.StallBadge     // M9.6 T2: nil when no recent stall_detected; auto-clears 5s after the event
	stallGeneration  int                        // M9.6 T2: increments per stall; tick closure captures + compares on expire
}

// stallExpireMsg is dispatched by a tea.Tick scheduled in the
// stall_detected handler. The closure captures the current
// stallGeneration; on fire, we compare against the model's gen — if
// they match, the badge is cleared. Mismatch means a NEWER stall arrived
// while we were waiting, so this tick is stale; the new tick will clear
// the (refreshed) badge on its own schedule. M9.6 T2 ADR M9.6-02.
type stallExpireMsg struct {
	gen int
}

// New constructs the App model. baseURL is the server origin (scheme +
// host + port, no trailing slash) — the model derives both the SSE
// stream URL and the /messages backlog URL from it. Pass an empty
// baseURL to skip both network operations (used by render-only tests).
func New(sessionID, baseURL string) Model {
	cwd, _ := os.Getwd()
	ctx, cancel := context.WithCancel(context.Background())

	// M9.5 T3: boot read from ~/.harness/config.json. Resolve in order:
	// (1) built-ins via theme.Resolve, (2) TOML user themes via
	// theme.LoadFromFile, (3) Dark final fallback. Errors stash on the
	// Model for surfacing on the first WindowSizeMsg as a dim marker.
	harnessHome := resolveHarnessHome()
	themeName := readThemeFromConfig(harnessHome)
	defaultTheme, themeErr := resolveBootTheme(themeName, harnessHome)

	st := components.NewStatusLine(defaultTheme)
	st.Cwd = cwd
	m := Model{
		keys:             defaultKeys(),
		transcript:       components.NewTranscript(defaultTheme),
		prompt:           components.NewPrompt(),
		statusLine:       st,
		sessionID:        sessionID,
		baseURL:          baseURL,
		ctx:              ctx,
		cancel:           cancel,
		theme:            defaultTheme,
		autocomplete:     components.NewSlashAutocomplete(defaultTheme),
		harnessHome:      harnessHome,
		pendingThemeErr:  themeErr,
		pendingThemeName: themeName,
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
	// Fire the backlog hydration + skill cache hydration in parallel with
	// the SSE subscription. On a resume the user sees prior turns
	// immediately; on a fresh session the messages fetch returns zero
	// messages and the handler is a no-op. The skills fetch populates
	// the leading-slash intercept cache so /skillname dispatches against
	// the project + user + bundle skill registry land server-side as
	// `kind: 'skill'` rather than as literal text. Failure of either
	// fetch is non-fatal — the message handlers degrade gracefully.
	if m.events == nil {
		return tea.Batch(m.fetchMessagesCmd(), m.fetchSkillsCmd())
	}
	return tea.Batch(m.fetchMessagesCmd(), m.fetchSkillsCmd(), m.waitEvent)
}

// fetchMessagesCmd issues the GET /sessions/<id>/messages backlog fetch
// off the Update goroutine. The result lands as a messagesFetchedMsg.
func (m Model) fetchMessagesCmd() tea.Cmd {
	return func() tea.Msg {
		msgs, err := transport.FetchMessages(m.ctx, m.baseURL, m.sessionID)
		return messagesFetchedMsg{messages: msgs, err: err}
	}
}

// fetchSkillsCmd issues the GET /sessions/<id>/skills hydration off the
// Update goroutine (M8 T6). The result populates m.skills so the
// leading-slash intercept in the ENTER handler can match user input
// against known skill names and POST as `kind: 'skill'` when matched.
// Failure is non-fatal — the skillsFetchedMsg handler surfaces a dim
// transcript line and falls back to no-skill-cache behavior.
//
// M9.6 T3: same Cmd is reused for /skills reload (manual refresh) and
// compaction_complete (auto-refresh after session-id pivot). The session
// id captured in the closure is m.sessionID at the time of the Cmd
// construction — callers must rebuild the Cmd after a pivot.
func (m Model) fetchSkillsCmd() tea.Cmd {
	return func() tea.Msg {
		skills, err := transport.GetSkills(m.ctx, m.baseURL, m.sessionID)
		return skillsFetchedMsg{skills: skills, err: err}
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
		// M9.5 T3 — surface the boot theme error (if any) once the
		// transcript has a viewport; before WindowSizeMsg the bubbles
		// viewport isn't sized and AppendLine would no-op the scroll.
		if m.pendingThemeErr != nil {
			m.transcript.AppendLine(m.theme.DimStyle().Render(
				fmt.Sprintf("could not load theme %q: %v (falling back to %s)", m.pendingThemeName, m.pendingThemeErr, m.theme.Name),
			))
			m.pendingThemeErr = nil
		}
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
		// M9 T5: diff view focus routing. Ctrl+] focuses the most-recent
		// FileEdit/FileWrite diff; Esc defocuses. j/k navigate while focused.
		if key := msg.String(); key == "ctrl+]" && m.mostRecentDiff != nil {
			m.mostRecentDiff.SetFocused(true)
			m.focus = focusDiffView
			return m, nil
		}
		if m.focus == focusDiffView && m.mostRecentDiff != nil {
			if msg.String() == "esc" {
				m.mostRecentDiff.SetFocused(false)
				m.focus = focusTranscript
				return m, nil
			}
			updated := m.mostRecentDiff.Update(msg)
			*m.mostRecentDiff = updated
			return m, nil
		}
		// M9 T8 — autocomplete popup routing. When visible, Tab/Esc/Up/Down
		// route here BEFORE the regular prompt input; other keys fall
		// through to the prompt update which then re-filters via SetFilter.
		if m.autocomplete.Visible() {
			switch msg.String() {
			case "tab":
				completion := m.autocomplete.Completion()
				if completion != "" {
					m.prompt.SetValue(completion + " ")
					m.autocomplete.Dismiss()
				}
				return m, nil
			case "up":
				m.autocomplete.MoveUp()
				return m, nil
			case "down":
				m.autocomplete.MoveDown()
				return m, nil
			case "esc":
				m.autocomplete.Dismiss()
				return m, nil
			}
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
			// M9 T8 — dismiss the autocomplete popup on any ENTER submission
			// so the suggestion overlay doesn't linger above the prompt.
			m.autocomplete.Dismiss()
			// M9 T1: intercept `/theme <name>` slash. Purely client-side —
			// no POST is fired; the model never sees the theme switch. Update
			// m.theme; later milestones (T3 markdown wiring, T6 toolcard,
			// T10 statusline) consume m.theme via constructor or accessor.
			if strings.HasPrefix(text, "/theme") {
				m.transcript.AppendLine("» " + text)
				m.prompt.Clear()
				parts := strings.SplitN(text, " ", 2)
				if len(parts) < 2 {
					m.transcript.AppendLine(m.theme.DimStyle().Render("usage: /theme <light|dark|tokyo-night|sovereign|...>"))
					return m, nil
				}
				name := strings.TrimSpace(parts[1])
				newTheme, ok := theme.Resolve(name)
				if !ok {
					// M9.5 T3 — Resolve miss falls back to LoadFromFile so
					// user-custom themes at ~/.harness/themes/<name>.toml work.
					if loaded, err := theme.LoadFromFile(name, themesDir(m.harnessHome)); err == nil {
						newTheme = loaded
						ok = true
					}
				}
				if !ok {
					m.transcript.AppendLine(m.theme.ErrorStyle().Render("unknown theme: " + name))
					return m, nil
				}
				m.theme = newTheme
				m.transcript.SetTheme(m.theme)
				m.autocomplete.SetTheme(m.theme)
				m.statusLine.SetTheme(m.theme)
				// M9.5 T3 — persist the choice to ~/.harness/config.json. ADR
				// M9.5-02: synchronous best-effort; failure logs a dim marker
				// but doesn't roll back the in-memory switch.
				if err := writeThemeToConfig(m.harnessHome, name); err != nil {
					m.transcript.AppendLine(m.theme.DimStyle().Render(fmt.Sprintf("could not persist theme: %v", err)))
				}
				m.transcript.AppendLine(m.theme.DimStyle().Render("theme: " + name))
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
			// M8 T6 — /expand [N] interception. Re-renders the Nth-most-recent
			// tool block from the local ring buffer with no truncation. Purely
			// client-side — no POST is fired. The echo line uses the same "» "
			// prefix as a normal turn so the user sees what they typed; the
			// expandToolBlock call appends the rendered block (or an error
			// marker if N is out of range) below it. No "[thinking]" placeholder
			// because there's no network round trip.
			if n, ok := parseExpandCommand(text); ok {
				m.transcript.AppendLine("» " + text)
				m.prompt.Clear()
				return m, m.expandToolBlock(n)
			}
			// M9.6 T3 — /skills <verb> subcommand parser. Must run BEFORE
			// the /skillname matcher below so the literal /skills text is
			// captured as a subcommand instead of being treated as a (non-
			// existent) skill named "skills". ADR M9.6-03.
			if text == "/skills" || strings.HasPrefix(text, "/skills ") {
				m.transcript.AppendLine("» " + text)
				m.prompt.Clear()
				m.autocomplete.Dismiss()
				parts := strings.SplitN(text, " ", 2)
				verb := ""
				if len(parts) == 2 {
					verb = strings.TrimSpace(parts[1])
				}
				switch verb {
				case "reload":
					if m.baseURL == "" {
						m.transcript.AppendLine(m.theme.DimStyle().Render("skills cache unavailable (no server)"))
						return m, nil
					}
					m.transcript.AppendLine(m.theme.DimStyle().Render("reloading skill cache…"))
					return m, m.fetchSkillsCmd()
				case "":
					m.transcript.AppendLine(m.theme.DimStyle().Render("usage: /skills <reload>"))
				default:
					m.transcript.AppendLine(m.theme.ErrorStyle().Render("unknown /skills verb: " + verb))
				}
				return m, nil
			}
			// M8 T6 — /skillname interception. When the slash matches a
			// cached skill name (populated by fetchSkillsCmd on boot), POST
			// to /turns with `kind: 'skill'` so the server-side T5 handler
			// expands the prompt via expandSkillPrompt before saveMessage.
			// On no-match the input falls through to the normal turn POST
			// — the user might be typing a future slash command or a
			// literal /-prefixed string the model should see as-is.
			if name, ok := matchSkillSlash(text, m.skills); ok {
				m.transcript.AppendLine("» " + text)
				m.prompt.Clear()
				dimStyle := lipgloss.NewStyle().
					Foreground(lipgloss.Color("#6e7681")).
					Italic(true)
				m.transcript.AppendLine(dimStyle.Render("…expanding /" + name))
				m.thinkingPending = true
				return m, m.submitSkillTurn(text)
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
		// M9 T8 — after every prompt update, sync the autocomplete popup
		// against the new prompt text.
		m.autocomplete.SetFilter(m.prompt.Value())
		return m, cmd
	case tea.MouseMsg:
		// M9.6 T1: split click vs wheel/motion routing. Left-press events
		// dispatch by Y-coordinate against the transcript / autocomplete
		// popup regions; wheel + motion events forward to the transcript
		// viewport (M9 T9 behavior preserved).
		if msg.Action == tea.MouseActionPress && msg.Button == tea.MouseButtonLeft {
			return m.handleMouseClick(msg)
		}
		var cmd tea.Cmd
		m.transcript, cmd = m.transcript.Update(msg)
		return m, cmd
	case sseMsg:
		eventCmd := m.handleEvent(msg.env)
		return m, tea.Batch(m.waitEvent, eventCmd)
	case stallExpireMsg:
		// M9.6 T2: clear the badge only if no NEWER stall has arrived.
		// Stale ticks (older gen than current) are no-ops; the newer
		// stall's own tick will clear the refreshed badge.
		if msg.gen == m.stallGeneration {
			m.stallBadge = nil
		}
		return m, nil
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
	case skillsFetchedMsg:
		// M8 T6: store the cached skill list. On failure we surface a dim
		// line and continue — the slash intercept falls through to normal
		// turn dispatch when m.skills is empty, so the TUI stays usable
		// even if the /skills route is offline. No visible marker on
		// success — the cache is silently warmed.
		if msg.err != nil {
			m.transcript.AppendLine(
				lipgloss.NewStyle().
					Foreground(lipgloss.Color("#6e7681")).
					Italic(true).
					Render(fmt.Sprintf("could not load skills: %v", msg.err)),
			)
			return m, nil
		}
		m.skills = msg.skills
		m.autocomplete.SetSkills(msg.skills) // M9 T8 — surface skills in the popup
		return m, nil
	}
	var cmd tea.Cmd
	m.transcript, cmd = m.transcript.Update(msg)
	return m, cmd
}

// handleEvent dispatches an SSE envelope into the model state. Returns
// an optional tea.Cmd for events that need to schedule follow-up work
// (M9.6 T2: stall_detected schedules a tea.Tick for badge auto-clear;
// M9.6 T3: compaction_complete returns a refetch-skills cmd). Callers
// in Update batch the returned cmd with m.waitEvent so neither is dropped.
func (m *Model) handleEvent(env transport.Envelope) tea.Cmd {
	switch env.Type {
	case "text_delta":
		td, err := transport.DecodeTextDelta(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		// M9 T3 — stream the delta into the in-progress assistant card and
		// re-render via render.Markdown. Non-text events finalize the card
		// (see tool_use_start, tool_result, turn_complete below).
		m.transcript.AppendAssistantDelta(td.Text)
	case "thinking_delta":
		td, err := transport.DecodeThinkingDelta(env.Raw)
		if err != nil {
			return nil
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
			return nil
		}
		m.clearThinkingIfPending()
		m.transcript.EndAssistantCard() // M9 T3 — finalize any streaming text before the tool card
		m.transcript.AppendLine(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#6e7681")).
				Render(fmt.Sprintf("-> %s starting...", tus.Tool)),
		)
	case "tool_result":
		tr, err := transport.DecodeToolResult(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		m.transcript.EndAssistantCard() // M9 T3 — finalize any streaming text before the tool card
		hint := tr.RenderHint
		if hint == "" {
			hint = "text"
		}
		// M9 T5 — detect FileEdit / FileWrite and parse the output as a
		// unified diff. If hunks are present, construct a DiffView, expand
		// the card by default, and track the pointer for Ctrl+] focus.
		var diff *components.DiffView
		if tr.Tool == "FileEdit" || tr.Tool == "FileWrite" {
			dv := components.NewDiffView(string(tr.Output), m.theme)
			if dv.HasHunks() {
				diff = &dv
				m.mostRecentDiff = diff
			}
		}
		card := components.ToolCard{
			Tool:       tr.Tool,
			RenderHint: hint,
			Summary:    fmt.Sprintf("rendered as %s", hint),
			Input:      string(tr.Input),  // M9 T6 — collapsed-card preview source
			Output:     string(tr.Output),
			Language:   tr.Language,
			Theme:      m.theme, // M9 T4 — pass theme so the body renders via render.Code
			Expanded:   diff != nil, // M9 T5 — auto-expand diffs so the user sees the hunks
			Diff:       diff,
		}
		// M9.6 T1: AppendLineAsCard retains the card struct so a mouse
		// click in the transcript can flip Expanded and re-render in place.
		m.transcript.AppendLineAsCard(card)
		// M8 T6 — record the block onto the local ring for /expand [N]
		// re-render. The wire `output` is json.RawMessage so we render
		// it as a string verbatim; the expand path treats it as plain
		// text (multi-line splits on \n) which matches how the user
		// would read raw tool output in a debug log. The card view above
		// is a one-line summary; the ring keeps the full payload.
		m.appendCompletedBlock(CompletedBlock{
			Seq:    env.Seq,
			Tool:   tr.Tool,
			Output: string(tr.Output),
		})
	case "permission_request":
		// M5 T9: push the interactive permission modal. The modal renders
		// as a centered yellow box; key dispatch is routed to it in
		// Update() until the user picks y/n/a (or Enter/Esc default to
		// deny). The choice produces a PermissionSubmitMsg, which the
		// Update handler POSTs to /sessions/:id/approvals/:requestId.
		pr, err := transport.DecodePermissionRequest(env.Raw)
		if err != nil {
			return nil
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
			return nil
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
			m.transcript.EndAssistantCard() // M9 T3
			m.transcript.AppendLine("[turn complete]")
			return nil
		}
		m.clearThinkingIfPending()
		m.transcript.EndAssistantCard() // M9 T3 — finalize the streamed card before the marker
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
		// M9 T7: styled inline pill replaces the dim one-liner.
		cc, err := transport.DecodeCompactionComplete(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		m.transcript.EndAssistantCard() // M9 T3 — finalize any streaming text
		m.sessionID = cc.ActiveSessionID
		m.transcript.AppendLine(components.RenderCompactionCard(
			cc.EstimatedBeforeTokens,
			cc.EstimatedAfterTokens,
			shortSessionID(cc.ActiveSessionID),
			m.theme,
			m.width,
		))
		// M9.6 T3 — invalidate the skill cache on session-id pivot.
		// The post-pivot child session may have a different skill set;
		// fetchSkillsCmd captures the CURRENT m.sessionID (just updated
		// above), so the refetch targets the new child id automatically.
		return m.fetchSkillsCmd()
	case "session_summary":
		// M9 T7 — server emitted the rich session summary on disposal.
		// Store the payload; View() renders the goodbye card in place of
		// the transcript on subsequent frames.
		ss, err := transport.DecodeSessionSummary(env.Raw)
		if err != nil {
			return nil
		}
		m.goodbyeSummary = &ss
	case "status_update":
		// M9 T10 — drive the streaming spinner + live cost on the status
		// line. The server emits streaming:true at turn start and
		// streaming:false on completion (with cost+tokens populated).
		// Missing fields stay zero — partial payloads degrade gracefully.
		su, err := transport.DecodeStatusUpdate(env.Raw)
		if err != nil {
			return nil
		}
		m.statusLine.Streaming = su.Streaming
		if su.Cost > 0 {
			m.statusLine.Cost = su.Cost
		}
		if su.TokensIn > 0 {
			m.statusLine.TokensIn = su.TokensIn
		}
		if su.TokensOut > 0 {
			m.statusLine.TokensOut = su.TokensOut
		}
		if su.CacheHitRate > 0 {
			m.statusLine.CacheHit = su.CacheHitRate
		}
	case "stall_detected":
		// M9.6 T2: paint the stall badge for 5 seconds. Increment the
		// generation so any stale tick from an earlier stall (still in
		// flight) becomes a no-op when it fires (see stallExpireMsg case
		// in Update). The closure captures the generation at schedule time.
		sd, err := transport.DecodeStallDetected(env.Raw)
		if err != nil {
			return nil
		}
		m.stallGeneration++
		capturedGen := m.stallGeneration
		m.stallBadge = &components.StallBadge{
			Reason: sd.Reason,
			Theme:  m.theme,
		}
		return tea.Tick(5*time.Second, func(time.Time) tea.Msg {
			return stallExpireMsg{gen: capturedGen}
		})
	}
	return nil
}

// handleMouseClick dispatches a left-press click by screen-Y to one of
// transcript (toolcard collapse-toggle), autocomplete popup (entry
// select+complete), or no-op (prompt + status rows). M9.6 T1, ADR M9.6-01.
//
// Layout from top to bottom (current frame's vertical stack):
//   transcript viewport (h = m.height - statusH - promptH - popupH)
//   autocomplete popup (h = 0 or N+2 when visible)
//   prompt (h = 2)
//   status (h = 1)
//
// T2 inserts a stall-badge row above the prompt when present; the
// transcriptH calculation is updated then.
func (m Model) handleMouseClick(msg tea.MouseMsg) (Model, tea.Cmd) {
	const statusH = 1
	const promptH = 2
	popupH := m.autocomplete.PopupHeight()

	transcriptH := m.height - statusH - promptH - popupH
	if transcriptH < 0 {
		transcriptH = 0
	}

	if msg.Y < transcriptH {
		// Click in transcript region.
		if cardIdx, ok := m.transcript.ClickAt(msg.Y); ok {
			m.transcript.ToggleCardExpanded(cardIdx)
		}
		return m, nil
	}
	if popupH > 0 {
		popupStart := transcriptH
		popupEnd := popupStart + popupH
		if msg.Y >= popupStart && msg.Y < popupEnd {
			// Click on autocomplete popup. Entry index is the row inside
			// the popup minus 1 for the top border.
			entryIdx := msg.Y - popupStart - 1
			if completion, ok := m.autocomplete.SelectAt(entryIdx); ok {
				m.prompt.SetValue(completion + " ")
				m.autocomplete.Dismiss()
			}
			return m, nil
		}
	}
	// Prompt + status rows + dead transcript area: no-op.
	return m, nil
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
	// M9 T7 — when the server has emitted session_summary, replace the
	// whole frame with the styled goodbye card. The TUI is about to exit
	// anyway; the card is the last thing the user sees.
	if m.goodbyeSummary != nil {
		return components.RenderGoodbye(*m.goodbyeSummary, m.theme, m.width, m.height)
	}
	// M5 T9: when a permission modal is active, overlay it over the whole
	// frame (Place centers the box inside width/height). v1 suppresses the
	// base layer to keep rendering simple; later milestones may composite
	// both so the user retains some peripheral context while choosing.
	if m.permission != nil && !m.permission.Done() {
		return m.permission.View(m.width, m.height)
	}
	// M9 T8 — autocomplete popup renders above the prompt row when visible.
	prompt := m.prompt.View()
	if m.autocomplete.Visible() {
		prompt = m.autocomplete.View(m.width) + "\n" + prompt
	}
	// M9.6 T2 — stall badge renders between transcript and prompt area.
	out := m.transcript.View() + "\n"
	if m.stallBadge != nil {
		out += m.stallBadge.View(m.width) + "\n"
	}
	out += prompt + "\n" + m.statusLine.View()
	return out
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

// submitSkillTurn POSTs the raw /skillname slash text to
// /sessions/<id>/turns with `kind: 'skill'` so the server-side T5
// handler at src/server/routes/turns.ts runs expandSkillPrompt before
// saveMessage. The model layer's slash intercept (matchSkillSlash) has
// already confirmed the name matches a known skill, so this Cmd's only
// job is the HTTP round trip. On error a turnSubmitErrMsg surfaces a
// red transcript line for visual parity with submitTurn.
func (m Model) submitSkillTurn(rawText string) tea.Cmd {
	return func() tea.Msg {
		if err := transport.PostSkillTurn(m.ctx, m.baseURL, m.sessionID, rawText); err != nil {
			return turnSubmitErrMsg{err: err}
		}
		return nil
	}
}

// matchSkillSlash returns (name, true) when text is a leading-slash
// command whose name matches one of the cached skills. Splits on the
// first space so `/greet Alice Bob` resolves the name to `greet` and
// drops the args (which travel along on the wire — the server-side
// expansion at src/server/routes/turns.ts:122-126 parses them).
//
// Returns (_, false) on any text that doesn't start with `/`, on an
// empty cache, or on a /name that isn't in the cache. The dispatch
// path falls through to normal turn submission in either case — the
// user might be typing a literal /-prefixed message the model should
// see as-is.
func matchSkillSlash(text string, skills []transport.Skill) (string, bool) {
	if len(skills) == 0 || !strings.HasPrefix(text, "/") {
		return "", false
	}
	stripped := text[1:]
	if stripped == "" {
		return "", false
	}
	name := stripped
	if space := strings.IndexByte(stripped, ' '); space != -1 {
		name = stripped[:space]
	}
	for _, s := range skills {
		if s.Name == name {
			return name, true
		}
	}
	return "", false
}
