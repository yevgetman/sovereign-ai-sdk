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

// commandsFetchedMsg carries the result of the backlog #45 GET
// /sessions/:id/commands hydration. On success the autocomplete's
// dynamic command list replaces the compile-time staticEntries; on
// failure the static fallback continues to drive the popup. Failure
// is non-fatal — the popup still works, just with the (potentially
// stale) hand-mirrored entries.
type commandsFetchedMsg struct {
	commands []transport.CommandDescriptor
	err      error
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
	picker           *components.PickerCard     // M11.5: inline picker card rendered from a pickerOpen side-effect; nil when no picker is active
	splashShown      bool                       // M11.1: splash rendered once on the first WindowSizeMsg
	spinner          components.Spinner         // M11.2: branded thinking indicator (Braille rotation + gradient color cycle)
	spinnerLineIdx   int                        // M11.2: transcript line index of the live spinner row; -1 when no spinner active
	spinnerLabel     string                     // M11.2: current spinner label ("thinking", "expanding /name", etc.)
	spinnerGen       int                        // M11.2: increments each time a new spinner starts; tick closure compares to drop stale ticks
	deltaGen         int                        // ux-fixes: bumps on every SSE event so idle-check ticks scheduled by content events can detect a still gap from a stale gen
}

// spinnerTickMsg is dispatched by the spinner's recurring tea.Tick. The
// captured gen tracks which spinner generation scheduled the tick; on
// fire we compare against m.spinnerGen and drop the tick when stale
// (e.g., the spinner was cleared by clearThinkingIfPending and a new
// one started in the meantime). M11.2.
type spinnerTickMsg struct {
	gen int
}

// spinnerTickInterval is how often the thinking spinner advances a
// frame. 80ms feels lively without being a strobe; matches Claude
// Code's perception. M11.2.
const spinnerTickInterval = 80 * time.Millisecond

// idleCheckMsg fires after a content event (text_delta, thinking_delta,
// tool_result) when no further event has arrived within idleCheckDelay.
// The captured gen is compared against m.deltaGen at the time the tick
// fires — mismatch means a newer event invalidated this check, so the
// spinner stays cleared. When still current, the handler restarts the
// branded thinking spinner so the user sees feedback during the
// post-text/pre-tool gap where the model is still composing its next
// block but has emitted nothing yet.
type idleCheckMsg struct {
	gen int
}

// idleCheckDelay is how long we wait after the most recent content
// event before assuming the model is "still thinking" and restarting
// the spinner. 700ms is short enough to give prompt feedback during a
// real gap (often several seconds) but long enough to avoid flickering
// the spinner on a brief pause between adjacent text_deltas.
const idleCheckDelay = 700 * time.Millisecond

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
		spinner:          components.NewSpinner(),
		spinnerLineIdx:   -1,
	}
	if baseURL != "" {
		streamURL := fmt.Sprintf("%s/sessions/%s/events", baseURL, sessionID)
		m.events, m.errs = transport.Consume(ctx, streamURL)
	}
	return m
}

// WithSessionInfo seeds the model + provider on the status line so the
// splash card renders the real values from the first frame. The launcher
// (src/cli/tuiLauncher.ts) passes both as CLI flags to sov-tui, which
// invokes this on the freshly-constructed Model before tea.NewProgram.
// Empty arguments are ignored so callers that only know one of the two
// values can pass "" for the other. ux-fixes round 3.
func (m Model) WithSessionInfo(model, provider string) Model {
	if model != "" {
		m.statusLine.Model = model
	}
	if provider != "" {
		m.statusLine.Provider = provider
	}
	return m
}

// Layout chrome constants. The transcript fills the remaining vertical
// space after the prompt + chrome are subtracted from the terminal
// height. promptH is dynamic and tracked via m.prompt.Height() so the
// transcript shrinks as the input box grows (ux-fixes round 3,
// problem1/2/3.png feedback). Border math: a rounded-box prompt adds 2
// rows of chrome (top + bottom) on top of the textarea's row count.
const (
	statusH      = 1
	hintH        = 1 // "? for shortcuts" line between prompt and status
	spacerH      = 1 // blank row above the prompt for visual separation
	promptBorder = 2 // top + bottom rounded-border rows
)

// promptChromeH returns the total vertical chrome the prompt box
// occupies — textarea rows + border. Mirrored by handleMouseClick for
// the popup-position math.
func (m Model) promptChromeH() int {
	return m.prompt.Height() + promptBorder
}

// recomputeLayout sets the transcript's max height based on the current
// prompt height + fixed chrome. Called from WindowSizeMsg and whenever
// the prompt's height may have changed (e.g., after delegating a key
// event to the textarea). Width is taken from m.width which was set in
// the most recent WindowSizeMsg.
func (m *Model) recomputeLayout() {
	if m.width == 0 || m.height == 0 {
		return
	}
	maxTranscriptH := m.height - statusH - m.promptChromeH() - hintH - spacerH
	if maxTranscriptH < 1 {
		maxTranscriptH = 1
	}
	m.transcript.SetSize(m.width, maxTranscriptH)
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
		return tea.Batch(m.fetchMessagesCmd(), m.fetchSkillsCmd(), m.fetchCommandsCmd())
	}
	return tea.Batch(m.fetchMessagesCmd(), m.fetchSkillsCmd(), m.fetchCommandsCmd(), m.waitEvent)
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

// fetchCommandsCmd issues the backlog #45 GET /sessions/<id>/commands
// hydration off the Update goroutine. Result populates the
// autocomplete popup's dynamic command list (replacing staticEntries
// for production runs). Failure is non-fatal — the popup falls back
// to the compile-time staticEntries until a successful refetch.
func (m Model) fetchCommandsCmd() tea.Cmd {
	return func() tea.Msg {
		commands, err := transport.GetCommands(m.ctx, m.baseURL, m.sessionID)
		return commandsFetchedMsg{commands: commands, err: err}
	}
}

// skillInstalledMsg carries the result of a /skills install POST.
// On success, name is the frontmatter name and installedAt is the
// `<harnessHome>/skills/<name>/` path. Either err is non-nil OR result
// is set; never both. The Update handler renders a status line and
// fires fetchSkillsCmd on success so the new skill becomes visible in
// autocomplete + /skillname dispatch immediately. M11.17.
type skillInstalledMsg struct {
	result *transport.InstallSkillResult
	err    error
}

// skillUninstalledMsg carries the result of a /skills uninstall DELETE.
// On success, name is the removed skill's name. Update handler renders
// a status line and fires fetchSkillsCmd to refresh the cache. M11.17.
type skillUninstalledMsg struct {
	result *transport.UninstallSkillResult
	err    error
}

// installSkillCmd issues POST /sessions/:id/skills/install off the
// Update goroutine. The result lands as a skillInstalledMsg. M11.17.
func (m Model) installSkillCmd(source string) tea.Cmd {
	return func() tea.Msg {
		// force:false — surface the "already installed" error so the
		// user explicitly confirms re-install via uninstall first.
		result, err := transport.InstallSkill(m.ctx, m.baseURL, m.sessionID, source, false)
		return skillInstalledMsg{result: result, err: err}
	}
}

// uninstallSkillCmd issues DELETE /sessions/:id/skills/:name off the
// Update goroutine. The result lands as a skillUninstalledMsg. M11.17.
func (m Model) uninstallSkillCmd(name string) tea.Cmd {
	return func() tea.Msg {
		result, err := transport.UninstallSkill(m.ctx, m.baseURL, m.sessionID, name)
		return skillUninstalledMsg{result: result, err: err}
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
		m.prompt.SetWidth(msg.Width)
		m.statusLine.SetWidth(msg.Width)
		m.recomputeLayout()
		// M9.5 T3 — surface the boot theme error (if any) once the
		// transcript has a viewport; before WindowSizeMsg the bubbles
		// viewport isn't sized and AppendLine would no-op the scroll.
		if m.pendingThemeErr != nil {
			m.transcript.AppendLine(m.theme.DimStyle().Render(
				fmt.Sprintf("could not load theme %q: %v (falling back to %s)", m.pendingThemeName, m.pendingThemeErr, m.theme.Name),
			))
			m.pendingThemeErr = nil
		}
		// M11.1 — splash on the first WindowSizeMsg. Renders the SOV
		// brand mark + tips line so the TUI default surface shows the
		// same boot cue the REPL does. Splash precedes any backlog
		// hydration content for resumed sessions (messagesFetchedMsg
		// arrives after the first WindowSizeMsg in practice).
		// Gated on baseURL — render-only tests pass "" and rely on
		// specific Y coordinates for click handling; production always
		// has a real server URL.
		if !m.splashShown && m.baseURL != "" {
			cwd, _ := os.Getwd()
			home := os.Getenv("HOME")
			// ux-fixes round 3: Provider + Model come from m.statusLine
			// (seeded by main.go's WithSessionInfo from --model/--provider
			// CLI flags the launcher passes). Auth stays hardcoded as
			// "API Key" because we don't yet plumb auth-mode through the
			// transport.
			provider := m.statusLine.Provider
			if provider == "" {
				provider = "anthropic"
			}
			info := components.SplashInfo{
				Version:  "0.1.0",
				Provider: provider,
				Auth:     "API Key",
				Model:    m.statusLine.Model,
				Cwd:      cwd,
				Tips:     "Tips: type / for slash commands · @file:path to inline files · /quit to exit",
			}
			m.transcript.AppendLine(components.RenderSplash(info, m.theme, msg.Width))
			// M11.6 — boot notices appended INTO the transcript (not
			// rendered in View()) so they scroll away as the session
			// builds output below them. Previously they sat anchored
			// above the prompt for the entire session, which read as
			// permanent chrome instead of one-time boot guidance.
			bundlePath := os.Getenv("HARNESS_BUNDLE")
			for _, notice := range components.BootNotices(cwd, home, bundlePath) {
				m.transcript.AppendLine(components.Notification(notice, m.theme, msg.Width))
			}
			m.splashShown = true
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
		// M11.5 — picker card routing. When active, the picker absorbs
		// all keys: ↑/↓ navigate, Enter dispatches the chosen value,
		// Esc cancels (quiet dismiss + dim "cancelled." marker). Other
		// keys are swallowed — input is locked while the card is up,
		// matching the permission-modal pattern.
		if m.picker != nil {
			switch msg.String() {
			case "up":
				m.picker.MoveUp()
				return m, nil
			case "down":
				m.picker.MoveDown()
				return m, nil
			case "enter":
				value, ok := m.picker.Selected()
				if !ok {
					// Empty picker — defensive; the server shouldn't
					// emit a payload with zero items, but if it does
					// we close the card without dispatching.
					m.picker = nil
					return m, nil
				}
				cmdName := m.picker.Command()
				m.picker = nil
				if m.baseURL == "" {
					m.transcript.AppendLine(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
					return m, nil
				}
				m.transcript.AppendLine(m.theme.DimStyle().Render("…running /" + cmdName + " " + value))
				return m, dispatchCommandCmd(m.baseURL, m.sessionID, cmdName, value)
			case "esc":
				m.picker = nil
				m.transcript.AppendLine(m.theme.DimStyle().Render("(cancelled)"))
				return m, nil
			}
			return m, nil
		}
		// M9 T8 — autocomplete popup routing. When visible, Tab/Enter/Esc/Up/Down
		// route here BEFORE the regular prompt input; other keys fall
		// through to the prompt update which then re-filters via SetFilter.
		//
		// Post-M11.5 polish (uxissue2): Enter on the visible popup now
		// fills the highlighted completion and falls through to the
		// regular Enter submit handler below (so the command actually
		// runs, instead of submitting the literal "/" the user typed).
		// Tab still fills + space for users who want to type args first.
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
			case "enter":
				// Only replace the prompt with the highlighted
				// completion when the user hasn't started typing args
				// yet (no whitespace after the command name). Once
				// they've typed args (e.g., "/skills reload"), Enter
				// submits what they wrote verbatim — otherwise the
				// completion would clobber the args. The popup may
				// still be visible because its filter logic shows on
				// any leading "/", regardless of args.
				promptText := m.prompt.Value()
				if !strings.Contains(strings.TrimPrefix(promptText, "/"), " ") {
					if completion := m.autocomplete.Completion(); completion != "" {
						m.prompt.SetValue(completion)
					}
				}
				m.autocomplete.Dismiss()
				// Don't return — fall through to the regular Enter
				// handler below so the filled command actually submits.
			}
		}
		if key := msg.String(); key == "esc" || key == "ctrl+c" {
			m.cancel()
			return m, tea.Quit
		}
		// ux-fixes round 3 — Alt+Enter and Ctrl+J insert a real newline
		// into the prompt textarea instead of submitting. They flow
		// through to the textarea via the catch-all delegation at the
		// bottom of this branch. Plain Enter remains the submit key.
		if msg.Type == tea.KeyEnter && !msg.Alt {
			text := strings.TrimSpace(m.prompt.Value())
			if text == "" {
				return m, nil
			}
			// M9 T8 — dismiss the autocomplete popup on any ENTER submission
			// so the suggestion overlay doesn't linger above the prompt.
			m.autocomplete.Dismiss()
			// Backlog #46 — `/theme` no longer intercepted client-side.
			// It flows through the M10.5 generic dispatcher; the server
			// applies + persists; the themeChanged side-effect tells the
			// TUI to update m.theme + all components (handled inside
			// commandDispatchedMsg). The picker also works server-side
			// via the M11.5 pickerOpen protocol.
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
				m.transcript.AppendUserLine(text)
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
				m.transcript.AppendUserLine(text)
				m.prompt.Clear()
				return m, m.expandToolBlock(n)
			}
			// M9.6 T3 — /skills <verb> subcommand parser. Must run BEFORE
			// the /skillname matcher below so the literal /skills text is
			// captured as a subcommand instead of being treated as a (non-
			// existent) skill named "skills". ADR M9.6-03.
			// M11.17 — verbs: install <path>, uninstall <name>, reload, list.
			if text == "/skills" || strings.HasPrefix(text, "/skills ") {
				m.transcript.AppendUserLine(text)
				m.prompt.Clear()
				m.autocomplete.Dismiss()
				parts := strings.SplitN(text, " ", 2)
				rest := ""
				if len(parts) == 2 {
					rest = strings.TrimSpace(parts[1])
				}
				// Split rest into verb + arg for install/uninstall.
				verbParts := strings.SplitN(rest, " ", 2)
				verb := strings.TrimSpace(verbParts[0])
				verbArg := ""
				if len(verbParts) == 2 {
					verbArg = strings.TrimSpace(verbParts[1])
				}
				switch verb {
				case "reload":
					if m.baseURL == "" {
						m.transcript.AppendLine(m.theme.DimStyle().Render("skills cache unavailable (no server)"))
						return m, nil
					}
					m.transcript.AppendLine(m.theme.DimStyle().Render("reloading skill cache…"))
					return m, m.fetchSkillsCmd()
				case "install":
					if m.baseURL == "" {
						m.transcript.AppendLine(m.theme.ErrorStyle().Render("skills install requires a server connection"))
						return m, nil
					}
					if verbArg == "" {
						m.transcript.AppendLine(m.theme.DimStyle().Render("usage: /skills install <path-to-SKILL.md-or-directory>"))
						return m, nil
					}
					m.transcript.AppendLine(m.theme.DimStyle().Render("installing skill from " + verbArg + "…"))
					return m, m.installSkillCmd(verbArg)
				case "uninstall":
					if m.baseURL == "" {
						m.transcript.AppendLine(m.theme.ErrorStyle().Render("skills uninstall requires a server connection"))
						return m, nil
					}
					if verbArg == "" {
						m.transcript.AppendLine(m.theme.DimStyle().Render("usage: /skills uninstall <name>"))
						return m, nil
					}
					m.transcript.AppendLine(m.theme.DimStyle().Render("uninstalling skill " + verbArg + "…"))
					return m, m.uninstallSkillCmd(verbArg)
				case "list", "":
					// Render the cached skill list directly — no server round trip.
					if len(m.skills) == 0 {
						m.transcript.AppendLine(m.theme.DimStyle().Render("no skills loaded for this session"))
					} else {
						m.transcript.AppendLine(m.theme.DimStyle().Render(fmt.Sprintf("skills (%d):", len(m.skills))))
						for _, sk := range m.skills {
							m.transcript.AppendLine("  /" + sk.Name + "  " + m.theme.DimStyle().Render(sk.Description))
						}
					}
					m.transcript.AppendLine("")
					m.transcript.AppendLine(m.theme.DimStyle().Render("verbs: /skills [list] | install <path> | uninstall <name> | reload"))
				default:
					m.transcript.AppendLine(m.theme.ErrorStyle().Render("unknown /skills verb: " + verb))
					m.transcript.AppendLine(m.theme.DimStyle().Render("verbs: list, install <path>, uninstall <name>, reload"))
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
				m.transcript.AppendUserLine(text)
				m.prompt.Clear()
				// M11.2 — branded spinner for skill expansion. Same gen
				// counter as the main thinking spinner; clearThinkingIfPending
				// stops it on the first response event.
				m.thinkingPending = true
				spinCmd := m.startSpinner("expanding /" + name)
				return m, tea.Batch(m.submitSkillTurn(text), spinCmd)
			}
			// M10.5 — generic slash-command dispatch via /sessions/:id/commands.
			// Runs AFTER all dedicated branches so any leading-slash input that
			// didn't match (/theme, /compact, /expand, /skills <verb>, or a
			// known skill name) routes to the server's slash registry. Closes
			// the M10-audit slice 1 HIGH gap that blocked M11. Pre-M10.5 these
			// fell through to the normal turn POST and the model saw them as
			// plain text.
			if cmdName, cmdArgs, ok := parseGenericSlashCommand(text); ok {
				m.transcript.AppendUserLine(text)
				m.prompt.Clear()
				m.autocomplete.Dismiss()
				if m.baseURL == "" {
					m.transcript.AppendLine(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
					return m, nil
				}
				m.transcript.AppendLine(m.theme.DimStyle().Render("…running /" + cmdName))
				return m, dispatchCommandCmd(m.baseURL, m.sessionID, cmdName, cmdArgs)
			}
			m.transcript.AppendUserLine(text)
			m.prompt.Clear()
			// M11.2 — branded thinking spinner replaces the static dim
			// "…thinking" placeholder. The spinner advances every 80ms
			// via spinnerTickMsg until clearThinkingIfPending bumps
			// m.spinnerGen on the first response event.
			m.thinkingPending = true
			spinCmd := m.startSpinner("thinking")
			return m, tea.Batch(m.submitTurn(text), spinCmd)
		}
		var cmd tea.Cmd
		prevPromptH := m.prompt.Height()
		m.prompt, cmd = m.prompt.Update(msg)
		// ux-fixes round 3 — if the textarea's row count changed
		// (content wrapped to a new visual line, or shrank), resize
		// the transcript so total vertical chrome stays within the
		// terminal. WindowSizeMsg already sized everything; this only
		// fires mid-session as the user types.
		if m.prompt.Height() != prevPromptH {
			m.recomputeLayout()
		}
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
	case spinnerTickMsg:
		// M11.2: animate the thinking spinner. Drop stale ticks
		// (gen mismatch means clearThinkingIfPending invalidated us
		// or a newer startSpinner ran). When still current, advance
		// the frame, update the line in place, and schedule the
		// next tick — recurring chain that stops naturally on the
		// next clearThinkingIfPending.
		if msg.gen != m.spinnerGen || m.spinnerLineIdx < 0 || !m.thinkingPending {
			return m, nil
		}
		m.spinner = m.spinner.Tick()
		m.transcript.UpdateLiveLine(m.spinnerLineIdx, m.spinner.View(m.spinnerLabel))
		capturedGen := m.spinnerGen
		return m, tea.Tick(spinnerTickInterval, func(time.Time) tea.Msg {
			return spinnerTickMsg{gen: capturedGen}
		})
	case idleCheckMsg:
		// ux-fixes: a content event (text_delta / thinking_delta /
		// tool_result) scheduled an idle-check tick. If m.deltaGen has
		// advanced past the captured gen, a newer event already arrived
		// — drop. If a spinner is already active (e.g., from the
		// initial ENTER) keep it running rather than appending a second.
		// Otherwise the model has been silent for idleCheckDelay; show
		// the branded spinner so the user sees the gap as "still
		// thinking" instead of as a dead UI.
		if msg.gen != m.deltaGen || m.thinkingPending {
			return m, nil
		}
		m.thinkingPending = true
		return m, m.startSpinner("thinking")
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
					m.transcript.AppendUserLine(block.Text)
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
	case commandsFetchedMsg:
		// Backlog #45 — store the dynamic command list. Failure is
		// non-fatal: the autocomplete falls back to its compile-time
		// staticEntries until a refetch succeeds. Silent on success —
		// no transcript noise for a behind-the-scenes hydration. Silent
		// on failure too (no dim line) because staticEntries continues
		// to drive the popup — the user sees no degradation worth
		// announcing.
		if msg.err == nil {
			m.autocomplete.SetCommands(msg.commands)
		}
		return m, nil
	case skillInstalledMsg:
		// M11.17 — render install result and refresh the skill cache on
		// success so the new skill becomes available immediately for
		// /skillname dispatch + autocomplete suggestions.
		if msg.err != nil {
			m.transcript.AppendLine(m.theme.ErrorStyle().Render("skill install failed: " + msg.err.Error()))
			return m, nil
		}
		if msg.result == nil {
			m.transcript.AppendLine(m.theme.ErrorStyle().Render("skill install returned no result"))
			return m, nil
		}
		m.transcript.AppendLine(m.theme.DimStyle().Render(
			fmt.Sprintf("installed /%s → %s", msg.result.Name, msg.result.InstalledAt),
		))
		return m, m.fetchSkillsCmd()
	case skillUninstalledMsg:
		// M11.17 — render uninstall result and refresh the skill cache.
		if msg.err != nil {
			m.transcript.AppendLine(m.theme.ErrorStyle().Render("skill uninstall failed: " + msg.err.Error()))
			return m, nil
		}
		if msg.result == nil {
			m.transcript.AppendLine(m.theme.ErrorStyle().Render("skill uninstall returned no result"))
			return m, nil
		}
		m.transcript.AppendLine(m.theme.DimStyle().Render(
			fmt.Sprintf("uninstalled /%s (removed %s)", msg.result.Name, msg.result.RemovedFrom),
		))
		return m, m.fetchSkillsCmd()
	case commandDispatchedMsg:
		// M10.5 — pop the "…running /name" placeholder; render the dispatch
		// result. Two failure channels:
		//   - msg.err is a transport-level Go error (network, decode, non-2xx).
		//     Surface in red, same style as turnSubmitErrMsg.
		//   - msg.resp.Error is a command-level error (unknown command,
		//     handler throw). Surface in warning style.
		// Successful output renders verbatim. SideEffects update m.model
		// and (future) hop m.sessionID for /clear.
		m.transcript.RemoveLastLine()
		if msg.err != nil {
			m.transcript.AppendLine(
				lipgloss.NewStyle().
					Foreground(lipgloss.Color("#e06c75")).
					Render(fmt.Sprintf("/%s failed: %v", msg.name, msg.err)),
			)
			return m, nil
		}
		if msg.resp != nil && msg.resp.Error != "" {
			m.transcript.AppendLine(
				lipgloss.NewStyle().
					Foreground(m.theme.Warning).
					Bold(true).
					Render(msg.resp.Error),
			)
			return m, nil
		}
		// M11.5 — pickerOpen side-effect opens an inline card. Picker
		// payloads typically come with empty output; if non-empty, we
		// still render it as a label above the card.
		if msg.resp != nil && msg.resp.SideEffects != nil && msg.resp.SideEffects.PickerOpen != nil {
			if msg.resp.Output != "" {
				for _, line := range strings.Split(msg.resp.Output, "\n") {
					m.transcript.AppendLine(line)
				}
			}
			picker := components.NewPickerCard(*msg.resp.SideEffects.PickerOpen, m.theme)
			m.picker = &picker
			return m, nil
		}
		if msg.resp != nil && msg.resp.Output != "" {
			// Append each output line individually so transcript scroll
			// math stays accurate (Transcript.AppendLine is single-line).
			for _, line := range strings.Split(msg.resp.Output, "\n") {
				m.transcript.AppendLine(line)
			}
		}
		// Apply sideEffects. SessionID pivot (newSessionId) and exit
		// signals fire even on empty output. Note: StatusLine doesn't
		// dynamically render the model (M2 fixed-field design); the
		// model change is visible via the command's output text — no
		// statusline mutation needed in M10.5.
		if msg.resp != nil && msg.resp.SideEffects != nil {
			se := msg.resp.SideEffects
			if se.NewSessionID != "" {
				m.sessionID = se.NewSessionID
				m.transcript.AppendLine(
					m.theme.DimStyle().Render(
						fmt.Sprintf("─ session %s", shortSessionID(se.NewSessionID)),
					),
				)
			}
			// Backlog #46 — apply theme client-side. The server has
			// already persisted to ~/.harness/config.json via
			// applyAndPersistTheme; this is the runtime apply for the
			// Go renderer (m.theme is a separate process from the TS
			// theme singleton). Failure to resolve is non-fatal —
			// the response output line already showed success, so a
			// late "unknown theme" here would be confusing; we just
			// log a dim marker.
			if se.ThemeChanged != "" {
				if err := m.applyThemeByName(se.ThemeChanged); err != nil {
					m.transcript.AppendLine(
						m.theme.DimStyle().Render(
							fmt.Sprintf("could not apply theme '%s' client-side: %v", se.ThemeChanged, err),
						),
					)
				}
			}
			if se.ExitRequested {
				return m, tea.Quit
			}
		}
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
// applyThemeByName resolves the named theme and updates m.theme + all
// theme-aware components. Returns nil on success, error on unknown
// name. Backlog #46: extracted from the prior /theme client-side
// interceptor so the post-dispatch themeChanged side-effect handler
// can reuse the same logic. Persistence is the SERVER's job now —
// applyAndPersistTheme (TS side) writes to ~/.harness/config.json
// before emitting the side-effect.
func (m *Model) applyThemeByName(name string) error {
	newTheme, ok := theme.Resolve(name)
	if !ok {
		if loaded, err := theme.LoadFromFile(name, themesDir(m.harnessHome)); err == nil {
			newTheme = loaded
			ok = true
		}
	}
	if !ok {
		return fmt.Errorf("unknown theme: %s", name)
	}
	m.theme = newTheme
	m.transcript.SetTheme(m.theme)
	m.autocomplete.SetTheme(m.theme)
	m.statusLine.SetTheme(m.theme)
	if m.picker != nil {
		m.picker.SetTheme(m.theme)
	}
	return nil
}

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
		// ux-fixes — re-arm the spinner for the gap between this text
		// block ending and the next block (tool_use_start, another text
		// block, or turn_complete). If another delta or terminal event
		// arrives within idleCheckDelay, the captured gen is stale and
		// the tick no-ops in Update.
		return m.scheduleIdleCheck()
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
		// ux-fixes — extended-thinking blocks have the same post-block
		// gap as text blocks; arm the idle-check spinner.
		return m.scheduleIdleCheck()
	case "tool_use_start":
		_, err := transport.DecodeToolUseStart(env.Raw)
		if err != nil {
			return nil
		}
		// M11.12 — clear the thinking spinner and finalize any
		// streaming assistant text, but do NOT emit a separate
		// "→ <Tool> starting..." line. The subsequent tool_result event
		// renders the full tool card (with header + output), which is
		// the only visible artifact the user needs to see. The starting
		// line was redundant pre-M11.12 — same information as the
		// card's header, but without the result content.
		m.clearThinkingIfPending()
		m.transcript.EndAssistantCard() // M9 T3 — finalize any streaming text before the tool card
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
		// ux-fixes — after a tool_result, the model often pauses to
		// compose its next block (another tool call, follow-up text,
		// or turn_complete). Arm the idle-check spinner so the gap
		// reads as "still working" rather than as a dead UI.
		return m.scheduleIdleCheck()
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
			// Schema parse failed — still surface a separator so the
			// user sees turn boundaries; failure mode degrades to the
			// same visual as a normal end_turn.
			m.clearThinkingIfPending()
			m.transcript.EndAssistantCard() // M9 T3
			m.transcript.AppendLine(turnSeparator(m.theme, m.width))
			return nil
		}
		m.clearThinkingIfPending()
		m.transcript.EndAssistantCard() // M9 T3 — finalize the streamed card before the separator
		// M11.7 — pure separator line, no text. Previously rendered
		// "─ turn complete" / "─ turn complete (max_tokens)" which read
		// as system noise between conversational turns. Now: a single
		// dim horizontal rule, with the finish reason surfaced ONLY
		// when it's something the user should notice (non-end_turn).
		if tc.FinishReason == "" || tc.FinishReason == "end_turn" {
			m.transcript.AppendLine(turnSeparator(m.theme, m.width))
		} else {
			dim := lipgloss.NewStyle().Foreground(m.theme.Dim).Italic(true)
			m.transcript.AppendLine(turnSeparator(m.theme, m.width))
			m.transcript.AppendLine(dim.Render("  ⚠ " + tc.FinishReason))
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
//   prompt (h = 2)
//   autocomplete popup (h = 0 or N+2 when visible)  ← below prompt post-uxissue1
//   status (h = 1)
//
// T2 inserts a stall-badge row above the prompt when present; the
// transcriptH calculation is updated then.
func (m Model) handleMouseClick(msg tea.MouseMsg) (Model, tea.Cmd) {
	// ux-fixes round 3 — promptH is now dynamic so the click-Y math
	// stays correct as the input box grows past one row.
	promptH := m.promptChromeH()
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
		// Popup now sits BELOW the prompt (uxissue1).
		popupStart := transcriptH + promptH
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
//
// M11.2 — also invalidates the live spinner generation so any in-flight
// spinnerTickMsg fires no-op and the recurring tick chain stops.
//
// ux-fixes — also bumps deltaGen so any in-flight idleCheckMsg (scheduled
// by an earlier content event) becomes stale and no-ops on fire. The
// generation is bumped unconditionally so the bookkeeping holds even
// when there is no active spinner to clear.
func (m *Model) clearThinkingIfPending() {
	m.deltaGen++
	if !m.thinkingPending {
		return
	}
	m.transcript.RemoveLastLine()
	m.thinkingPending = false
	m.spinnerLineIdx = -1
	m.spinnerGen++
}

// scheduleIdleCheck bumps m.deltaGen and returns a tea.Cmd that fires
// an idleCheckMsg capturing the new generation after idleCheckDelay.
// Callers use this from content-producing handlers (text_delta,
// thinking_delta, tool_result) so the spinner re-appears in the
// post-text/pre-next-block gap when the model is still composing but
// has emitted nothing yet. If any newer event arrives before the tick
// fires, m.deltaGen advances past the captured value and the tick is
// dropped in Update's idleCheckMsg branch.
func (m *Model) scheduleIdleCheck() tea.Cmd {
	m.deltaGen++
	captured := m.deltaGen
	return tea.Tick(idleCheckDelay, func(time.Time) tea.Msg {
		return idleCheckMsg{gen: captured}
	})
}

// startSpinner appends the branded thinking spinner to the transcript
// with the given label and returns a tea.Cmd that schedules the first
// frame-advance tick. The Update handler for spinnerTickMsg advances the
// frame, re-renders the line in place, and schedules the next tick — a
// recurring chain that stops on its own when m.spinnerGen has advanced
// past the captured gen (via clearThinkingIfPending). M11.2.
func (m *Model) startSpinner(label string) tea.Cmd {
	m.spinnerGen++
	m.spinner = components.NewSpinner()
	m.spinnerLabel = label
	m.spinnerLineIdx = m.transcript.AppendLiveLine(m.spinner.View(label))
	capturedGen := m.spinnerGen
	return tea.Tick(spinnerTickInterval, func(time.Time) tea.Msg {
		return spinnerTickMsg{gen: capturedGen}
	})
}

// turnSeparator renders a subtle horizontal rule between conversational
// turns. M11.7 introduced the pure visual delimiter (no "turn complete"
// text); M11.12 changes it to full-terminal-width and uses
// theme.Border instead of theme.Dim so the rule reads as ambient
// page-break chrome rather than as an active element — visible enough
// to mark the turn boundary, recessive enough to disappear into the
// background while reading.
func turnSeparator(t theme.Theme, width int) string {
	n := width
	if n < 8 {
		n = 8
	}
	rule := strings.Repeat("─", n)
	return lipgloss.NewStyle().Foreground(t.Border).Render(rule)
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
	// M9 T8 — autocomplete popup renders next to the prompt row when visible.
	// Post-M11.5 polish: popup drops DOWN below the input box (uxissue1
	// feedback), matching the standard dropdown-suggestion pattern users
	// expect from web UIs and Claude Code's reference. Pre-fix the popup
	// rendered above the input, which read as a separate panel rather
	// than a suggestion attached to what the user was typing.
	prompt := m.prompt.View()
	if m.autocomplete.Visible() {
		prompt = prompt + "\n" + m.autocomplete.View(m.width)
	}
	// M11.3 — hint line below the prompt, dim/italic. "? for shortcuts"
	// matches the Qwen Code reference layout. M11.6: notices used to
	// render here too but now sit inside the transcript so they scroll
	// away with the rest of the splash content.
	hint := components.HintLine("? for shortcuts", m.theme)

	// M9.6 T2 — stall badge renders between transcript and prompt area.
	// M11.5 (boxed-prompt increment) — blank line spacers between
	// transcript / prompt / status make the input box a clearly-
	// separated focal point.
	// M11.5 (picker card) — picker renders below the transcript and
	// above the prompt when active (ADR M11.5-01).
	// M11.5 (picker card, T8) — bumped the pre-prompt gap from one to
	// two blank lines so the running-command indicator no longer
	// crowds the input box (ux2.png feedback).
	out := m.transcript.View() + "\n"
	if m.stallBadge != nil {
		out += m.stallBadge.View(m.width) + "\n"
	}
	if m.picker != nil {
		out += m.picker.View(m.width) + "\n"
	}
	out += "\n\n" + prompt + "\n"
	if hint != "" {
		out += hint + "\n"
	}
	out += m.statusLine.View()
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
