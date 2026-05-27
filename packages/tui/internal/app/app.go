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
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/style"
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
	live             components.LiveRegion // ux-fixes round 5 — bottom-anchored live region above the prompt (streaming card + spinner + running-command indicator)
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
	inputCard        *components.InputCard      // 2026-05-24 config UX rebuild: inline input card rendered from an inputOpen side-effect; nil when no input editor is active
	initialCommand   string                     // 2026-05-24 config UX rebuild: slash command to fire once the splash is up (sov config bootstrap)
	initialFired     bool                       // 2026-05-24 config UX rebuild: guards the initial-command auto-fire so it runs exactly once
	configOnly       bool                       // 2026-05-24 patch: `sov config` standalone mode — hide prompt/status, exit when no modal is open
	configOnlyExit   bool                       // 2026-05-24 patch: latch set when the configOnly run is ready to quit (next tick returns tea.Quit)
	debugMode        bool                       // 2026-05-24 patch: when true, delegator lines surface lane provider/model via the [provider/model] suffix
	splashShown      bool                       // M11.1: splash rendered once on the first WindowSizeMsg
	spinner          components.Spinner         // M11.2: branded thinking indicator (Braille rotation + gradient color cycle)
	spinnerLineIdx   int                        // M11.2: transcript line index of the live spinner row; -1 when no spinner active
	spinnerLabel     string                     // M11.2: current spinner label ("thinking", "expanding /name", etc.)
	spinnerGen       int                        // M11.2: increments each time a new spinner starts; tick closure compares to drop stale ticks
	deltaGen         int                        // ux-fixes: bumps on every SSE event so idle-check ticks scheduled by content events can detect a still gap from a stale gen
	userCancelledTurn bool                      // ux-fixes round 4: ESC triggered POST /cancel — suppress the subsequent turn_error warning since we already showed "(interrupted by user)"
	harnessVersion    string                     // Phase 21: harness runtime version (from src/version.ts) injected via WithSessionInfo; rendered in the splash card
	// ux-fixes 2026-05-22: tool-call rendering mode + truncation cap.
	// "compact" (default) emits a single-line per tool_result using
	// components.FormatCompactToolLine. "detailed" emits the existing
	// bordered ToolCard with Output capped to toolOutputInlineLines
	// rows. -v / --verbose forwards from the launcher as verboseRaw
	// (orthogonal escape hatch — appends raw untruncated output below
	// either mode's rendering). Spec:
	// docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
	toolOutputMode        string
	toolOutputInlineLines int
	verboseRaw            bool
	// pendingPrintln queues content destined for the terminal's
	// scrollback above the live view. drainPrintln consolidates the
	// queue into a single tea.Println Cmd at the end of every Update
	// branch — emitting via Println instead of rendering inside
	// View() lets the terminal's NATIVE scrollback hold session
	// history (and lets wheel scroll + text selection work without
	// the TUI capturing mouse events). ux-fixes round 5.
	pendingPrintln []string
	// emittedPrintln retains every line drainPrintln has ever drained.
	// Production code never reads it; test helpers walk this slice so
	// assertions can inspect what was committed to terminal scrollback
	// (tea.Println output isn't visible via m.View()). ux-fixes round 5.
	emittedPrintln []string
}

// print queues a line for emission into the terminal scrollback at the
// end of the current Update. Multiple calls accumulate and are emitted
// in order via a single tea.Println at drain time. The string may
// contain embedded newlines — they pass through to the terminal.
// ux-fixes round 5.
func (m *Model) print(line string) {
	m.pendingPrintln = append(m.pendingPrintln, line)
}

// userMessageDisplayCap is the character ceiling on echoed user-submitted
// text before it gets truncated with a "[+N chars omitted]" notice.
// Long pastes still flow into the actual turn (the echo is purely a
// visual receipt); 1500 chars is a few paragraphs and reads fine in
// scrollback at typical widths. ux-fixes round 5.
const userMessageDisplayCap = 1500

// printUser is shorthand for printing a user-marker styled line —
// matches the round-1 AppendUserLine convention ("❯ " in Brand.AccentColor
// followed by the body in terminal default). Used for echoing the
// user's submission into scrollback.
//
// ux-fixes round 5 — wraps the body at the current terminal width so
// long submissions render across multiple lines instead of overflowing
// horizontally. Truncates above userMessageDisplayCap so a ten-thousand-
// character paste doesn't dominate the scrollback; the actual turn still
// ships the full content via the expanded prompt value.
func (m *Model) printUser(text string) {
	marker := lipgloss.NewStyle().Foreground(lipgloss.Color(style.S.Brand.AccentColor)).Bold(true).Render(style.S.Echo.Marker)
	body := text
	if len(body) > userMessageDisplayCap {
		omitted := len(body) - userMessageDisplayCap
		body = body[:userMessageDisplayCap] + lipgloss.NewStyle().
			Foreground(m.theme.Dim).
			Italic(true).
			Render(fmt.Sprintf(" …[+%d chars]", omitted))
	}
	width := m.width
	if width < 20 {
		width = 80
	}
	// Wrap the body to (width - markerWidth) so each wrapped row stays
	// inside the terminal and continuation lines hang under the marker
	// column. lipgloss.Width handles word boundaries.
	wrap := width - style.S.Echo.MarkerWidth
	if wrap < 10 {
		wrap = width
	}
	wrapped := lipgloss.NewStyle().Width(wrap).Render(body)
	// Prefix only the first line with the marker; subsequent wrapped
	// rows align under the body column via two spaces of indent.
	lines := strings.Split(wrapped, "\n")
	for i, line := range lines {
		if i == 0 {
			lines[i] = marker + line
		} else {
			lines[i] = "  " + line
		}
	}
	m.print(strings.Join(lines, "\n"))
}

// drainPrintln consolidates the queued lines into a single tea.Println
// Cmd (preserving order via newline-joining) and clears the queue.
// Returns nil when the queue is empty. Drained lines are retained in
// emittedPrintln for test inspection — production code does not read it.
func (m *Model) drainPrintln() tea.Cmd {
	if len(m.pendingPrintln) == 0 {
		return nil
	}
	combined := strings.Join(m.pendingPrintln, "\n")
	m.emittedPrintln = append(m.emittedPrintln, m.pendingPrintln...)
	m.pendingPrintln = nil
	return tea.Println(combined)
}

// respond batches the caller's cmd together with any queued Println
// output. Every Update branch returns through this helper so scrollback
// emission stays attached to the same Update tick the print queue was
// filled in.
func (m *Model) respond(cmd tea.Cmd) tea.Cmd {
	drain := m.drainPrintln()
	if drain == nil {
		return cmd
	}
	if cmd == nil {
		return drain
	}
	return tea.Batch(cmd, drain)
}

// emitSplash queues the splash card + boot notices into pendingPrintln
// so they land in terminal scrollback above the current frame. Called
// once at boot (from the WindowSizeMsg handler) and again after
// /clear's scrollback-wipe so the cleared session looks like a fresh
// boot. The shared helper guards against drift between the two paths.
// 2026-05-24 patch.
func (m *Model) emitSplash(width int) {
	cwd, _ := os.Getwd()
	home := os.Getenv("HOME")
	provider := m.statusLine.Provider
	if provider == "" {
		provider = "anthropic"
	}
	version := m.harnessVersion
	if version == "" {
		version = "dev"
	}
	info := components.SplashInfo{
		Version:  version,
		Provider: provider,
		Auth:     "API Key",
		Model:    m.statusLine.Model,
		Cwd:      cwd,
		Tips:     "Tips: type / for slash commands · @file:path to inline files · /quit to exit",
	}
	// ux-fixes 2026-05-22 (ux1.png): blank line before the splash so
	// the SOV logo doesn't sit flush against the user's shell prompt.
	m.print("")
	m.print(components.RenderSplash(info, m.theme, width))
	bundlePath := os.Getenv("HARNESS_BUNDLE")
	for _, notice := range components.BootNotices(cwd, home, bundlePath) {
		m.print(components.Notification(notice, m.theme, width))
	}
}

// wrapClearScrollback prepends the terminal-clear escape Cmd to the
// supplied Cmd via tea.Sequence so the clear runs first and any
// subsequent tea.Println output (queued via m.print → drainPrintln)
// lands in the now-empty scrollback. When `pending` is false the
// supplied Cmd is returned unchanged. 2026-05-24 patch.
func (m *Model) wrapClearScrollback(pending bool, cmd tea.Cmd) tea.Cmd {
	if !pending {
		return cmd
	}
	if cmd == nil {
		return clearTerminalScrollbackCmd
	}
	return tea.Sequence(clearTerminalScrollbackCmd, cmd)
}

// clearTerminalScrollbackCmd returns a tea.Cmd that writes the escape
// sequence to wipe the terminal's visible screen + scrollback buffer.
// Used by /clear (via the ClearScrollback side-effect) so the new
// child session starts visually fresh — without this, the user's old
// transcript stays in scrollback even after the server has hopped to
// a context-empty child session.
//
// Sequence:
//
//	ESC[2J — clear entire visible screen
//	ESC[3J — clear scrollback (xterm extension; supported by iTerm2,
//	         Terminal.app, Alacritty, Kitty, Wezterm, gnome-terminal)
//	ESC[H  — move cursor to top-left
//
// Bubble Tea will re-paint its frame at the bottom on the next tick;
// any tea.Println output queued for this tick lands in the now-empty
// scrollback above. 2026-05-24 patch.
func clearTerminalScrollbackCmd() tea.Msg {
	_, _ = os.Stdout.WriteString("\033[2J\033[3J\033[H")
	return nil
}

// splitConfigBackCommand splits an OnBack command string into the
// slash-command name + args. The dispatcher expects them separately;
// OnBack strings come as `"config"` or `"config <group-id>"`, so we
// split on the first space. 2026-05-24 patch.
func splitConfigBackCommand(back string) (string, string) {
	if i := strings.IndexByte(back, ' '); i != -1 {
		return back[:i], strings.TrimSpace(back[i+1:])
	}
	return back, ""
}

// maybeQuitAfterModalClose returns tea.Quit batched with the supplied
// cmd when (a) the TUI is in configOnly mode AND (b) no modal (picker
// or inputCard) remains open AND (c) the initial-command has already
// fired (so we don't quit immediately at boot). Otherwise returns the
// supplied cmd unchanged. 2026-05-24 patch.
func (m *Model) maybeQuitAfterModalClose(cmd tea.Cmd) tea.Cmd {
	if !m.configOnly || m.configOnlyExit {
		return cmd
	}
	if m.picker != nil || m.inputCard != nil {
		return cmd
	}
	if !m.initialFired {
		// Defensive — shouldn't reach here without the initial-command
		// having fired; if we did, don't quit prematurely.
		return cmd
	}
	m.configOnlyExit = true
	if cmd == nil {
		return tea.Quit
	}
	return tea.Batch(cmd, tea.Quit)
}

// cancelTurnCmd issues POST /sessions/:id/cancel off the Update
// goroutine. Result is dropped — the server's turn_error / turn_complete
// SSE event drives the actual UI state transition; this Cmd just trips
// the abort. ux-fixes round 4.
type cancelResultMsg struct{}

func (m Model) cancelTurnCmd() tea.Cmd {
	if m.baseURL == "" {
		return nil
	}
	return func() tea.Msg {
		// Errors are swallowed deliberately. If the cancel HTTP call
		// fails, the worst case is the user still sees the turn_error
		// when the server finishes normally (or hits its own timeout).
		// Nothing actionable to show — the dim "(interrupted by user)"
		// line already informed the user.
		_, _ = transport.PostCancel(m.ctx, m.baseURL, m.sessionID)
		return cancelResultMsg{}
	}
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
// the spinner. 400ms is short enough to give prompt feedback during a
// real gap (often several seconds) but long enough to avoid flickering
// the spinner on a brief pause between adjacent text_deltas.
const idleCheckDelay = 400 * time.Millisecond

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
		live:             components.NewLiveRegion(defaultTheme),
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
		// ux-fixes 2026-05-22 — defaults for the tool-output rendering
		// mode. The launcher overrides via WithToolOutput / WithVerboseRaw
		// based on user-settings + the -v flag; these defaults apply when
		// the launcher passes nothing (e.g., direct tests, future
		// alternative front-ends).
		toolOutputMode:        "compact",
		toolOutputInlineLines: 10,
		verboseRaw:            false,
	}
	if baseURL != "" {
		streamURL := fmt.Sprintf("%s/sessions/%s/events", baseURL, sessionID)
		m.events, m.errs = transport.Consume(ctx, streamURL)
	}
	return m
}

// WithSessionInfo seeds the model + provider + harness version on the
// status line so the splash card renders the real values from the first
// frame. The launcher (src/cli/tuiLauncher.ts) passes all three as CLI
// flags to sov-tui, which invokes this on the freshly-constructed Model
// before tea.NewProgram. Empty arguments are ignored so callers that
// only know some of the values can pass "" for the others. ux-fixes
// round 3 (model + provider); Phase 21 (harnessVersion).
func (m Model) WithSessionInfo(model, provider, harnessVersion string) Model {
	if model != "" {
		m.statusLine.Model = model
	}
	if provider != "" {
		m.statusLine.Provider = provider
	}
	if harnessVersion != "" {
		m.harnessVersion = harnessVersion
	}
	return m
}

// WithToolOutput seeds the tool_result rendering mode + truncation cap
// on the Model. The launcher (src/cli/tuiLauncher.ts) forwards
// userSettings.ui.toolOutput.{mode,inlineLines} as --tool-output-mode
// and --tool-output-inline-lines flags to sov-tui, which invokes this
// on the freshly-constructed Model before tea.NewProgram.
//
// Empty mode falls back to the Model's default ("compact"). The mode
// value is validated — anything other than "compact" or "detailed"
// silently coerces to "compact" so a malformed flag can't break tool
// rendering.
//
// inlineLines is accepted verbatim when non-negative (including 0,
// which is the schema-documented "header-only" mode). Negative values
// keep the Model's default. ux-fixes 2026-05-22.
func (m Model) WithToolOutput(mode string, inlineLines int) Model {
	switch mode {
	case "compact", "detailed":
		m.toolOutputMode = mode
	case "":
		// keep default
	default:
		m.toolOutputMode = "compact"
	}
	if inlineLines >= 0 {
		m.toolOutputInlineLines = inlineLines
	}
	return m
}

// WithVerboseRaw enables the orthogonal "print raw untruncated tool
// output below the compact/detailed rendering" escape hatch. The
// launcher forwards -v / --verbose as --verbose-raw to sov-tui.
// ux-fixes 2026-05-22.
func (m Model) WithVerboseRaw(v bool) Model {
	m.verboseRaw = v
	return m
}

// WithInitialCommand seeds a slash command to fire automatically once
// the TUI is up — the splash has rendered and the SSE consumer is
// running. Used by `sov config` to launch the TUI straight into
// `/config` without requiring the user to type anything. Empty value
// leaves the model in its default "wait for user input" state.
//
// The command should be in the form the user would type (with leading
// "/"), e.g., "/config" or "/help". An empty string disables the
// behavior. 2026-05-24 config UX rebuild.
func (m Model) WithInitialCommand(cmd string) Model {
	m.initialCommand = strings.TrimSpace(cmd)
	return m
}

// WithConfigOnly marks the TUI as `sov config` standalone mode: the
// prompt input + status line are hidden, the splash adapts to omit
// session/model/provider info, and the program exits cleanly when no
// modal (picker or input card) is open. Sub-picker Esc behaves like
// backspace (navigates back via OnBack) so users can climb the menu
// hierarchy without accidentally exiting. 2026-05-24 patch.
func (m Model) WithConfigOnly(on bool) Model {
	m.configOnly = on
	return m
}

// WithTaskRouter sets the task-routing preset label that the status
// line surfaces in place of the profile column. When non-empty,
// StatusLine renders "Task Router Active (<preset>)" so users see at
// a glance that routing is on AND which named preset is in effect.
// Empty value (default) means routing is off — the status line falls
// back to the standard profile display. 2026-05-24 patch.
func (m Model) WithTaskRouter(preset string) Model {
	m.statusLine.TaskRouter = strings.TrimSpace(preset)
	return m
}

// WithDebugMode enables granular surfaces tied to `debugMode.enabled`
// in config. Today: delegator_atom_started and delegator_atom_complete
// lines render the resolved provider/model in brackets after the lane
// name, so users see exactly which model handled a given response.
// 2026-05-24 patch.
func (m Model) WithDebugMode(on bool) Model {
	m.debugMode = on
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

// recomputeLayout updates layout-sensitive components after window or
// prompt-height changes. Called from WindowSizeMsg and whenever the
// prompt's height may have changed (e.g., after delegating a key event
// to the textarea). Width is taken from m.width which was set in the
// most recent WindowSizeMsg.
//
// ux-fixes round 5 — committed history goes to the terminal's
// scrollback via tea.Println, so there's no transcript height budget to
// reconcile. LiveRegion only needs width so the streaming card wraps
// correctly.
func (m *Model) recomputeLayout() {
	if m.width == 0 || m.height == 0 {
		return
	}
	m.live.SetWidth(m.width)
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
		// Surface the boot theme error (if any). ux-fixes round 5 —
		// emitted into terminal scrollback via the print queue.
		if m.pendingThemeErr != nil {
			m.print(m.theme.DimStyle().Render(
				fmt.Sprintf("could not load theme %q: %v (falling back to %s)", m.pendingThemeName, m.pendingThemeErr, m.theme.Name),
			))
			m.pendingThemeErr = nil
		}
		// Splash on the first WindowSizeMsg — printed once into terminal
		// scrollback so wheel-scroll users still see the boot cue at
		// the top of their history.
		if !m.splashShown && m.baseURL != "" {
			m.emitSplash(msg.Width)
			m.splashShown = true
		}
		// 2026-05-24 (config UX rebuild) — once the splash has rendered
		// and the SSE consumer is up (baseURL non-empty), fire the
		// initial command (if any). Used by `sov config` to launch the
		// TUI straight into `/config`. Guarded by initialFired so the
		// command runs exactly once across multiple WindowSizeMsg
		// dispatches (terminal resizes shouldn't re-fire).
		if !m.initialFired && m.initialCommand != "" && m.baseURL != "" {
			m.initialFired = true
			if cmdName, cmdArgs, ok := parseGenericSlashCommand(m.initialCommand); ok {
				m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + cmdName))
				return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, cmdName, cmdArgs))
			}
		}
		return m, m.respond(nil)
	case tea.KeyMsg:
		// ux-fixes round 5 — bracketed-paste handling. Bubbletea
		// returns ONE KeyMsg per paste with Paste=true and Runes
		// holding the entire pasted content (embedded newlines come
		// through as '\n' runes inside Runes — see
		// detectBracketedPaste in bubbletea/key_sequences.go). Flush
		// to the prompt immediately so the placeholder / verbatim text
		// is visible without waiting for the next keystroke (the round
		// 4 accumulator pattern caused the "doesn't show until you
		// type" symptom because the flush waited for a follow-up
		// non-paste event).
		if msg.Paste {
			content := string(msg.Runes)
			if !m.prompt.RegisterPaste(content) {
				m.prompt.InsertString(content)
			}
			m.recomputeLayout()
			m.autocomplete.SetFilter(m.prompt.Value())
			return m, m.respond(nil)
		}
		// M5 T9: when a permission modal is active, route ALL keys to it
		// (including Esc and Enter — the modal treats both as "deny"). The
		// modal sets done=true after the user's choice, after which it is
		// cleared by the PermissionSubmitMsg branch below.
		if m.permission != nil && !m.permission.Done() {
			updated, cmd := m.permission.Update(msg)
			m.permission = &updated
			return m, m.respond(cmd)
		}
		// M9 T5: diff view focus routing. Ctrl+] focuses the most-recent
		// FileEdit/FileWrite diff; Esc defocuses. j/k navigate while focused.
		if key := msg.String(); key == "ctrl+]" && m.mostRecentDiff != nil {
			m.mostRecentDiff.SetFocused(true)
			m.focus = focusDiffView
			return m, m.respond(nil)
		}
		if m.focus == focusDiffView && m.mostRecentDiff != nil {
			if msg.String() == "esc" {
				m.mostRecentDiff.SetFocused(false)
				m.focus = focusTranscript
				return m, m.respond(nil)
			}
			updated := m.mostRecentDiff.Update(msg)
			*m.mostRecentDiff = updated
			return m, m.respond(nil)
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
				return m, m.respond(nil)
			case "down":
				m.picker.MoveDown()
				return m, m.respond(nil)
			case "enter":
				value, ok := m.picker.Selected()
				if !ok {
					// Empty picker — defensive; the server shouldn't
					// emit a payload with zero items, but if it does
					// we close the card without dispatching.
					m.picker = nil
					return m, m.respond(nil)
				}
				cmdName := m.picker.Command()
				m.picker = nil
				if m.baseURL == "" {
					m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
					return m, m.respond(nil)
				}
				m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + cmdName + " " + value))
				return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, cmdName, value))
			case "esc":
				// 2026-05-24 patch (v2) — explicit cancel-and-exit via
				// OnCancel. /config pickers wire this to dispatch
				// `/config discard` which rolls back the draft session
				// before closing. Consistent across root + sub-pickers
				// inside /config.
				cancel := m.picker.OnCancel()
				if cancel != "" {
					m.picker = nil
					if m.baseURL == "" {
						m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
						return m, m.respond(nil)
					}
					m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + cancel))
					name, args := splitConfigBackCommand(cancel)
					return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, name, args))
				}
				// 2026-05-24 patch — in configOnly mode, Esc on a
				// sub-picker (one with OnBack) behaves like backspace
				// so the user climbs back instead of being dumped at
				// a stale screen. Esc on the root menu (no OnBack)
				// closes the picker and triggers the exit-when-no-
				// modal check at the end of this case.
				back := m.picker.OnBack()
				if m.configOnly && back != "" {
					m.picker = nil
					if m.baseURL == "" {
						m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
						return m, m.respond(nil)
					}
					m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + back))
					name, args := splitConfigBackCommand(back)
					return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, name, args))
				}
				m.picker = nil
				if !m.configOnly {
					m.print(m.theme.DimStyle().Render("(cancelled)"))
				}
				return m, m.maybeQuitAfterModalClose(m.respond(nil))
			case "s", "S":
				// 2026-05-24 patch (v3 — apply-then-save) — explicit
				// save-and-exit. /config pickers wire OnSave to dispatch
				// `/config commit`. When the user has a selectable
				// value highlighted, S dispatches that value FIRST (via
				// the picker's OnSelect command) and THEN dispatches
				// OnSave. This matches user intent: "apply my choice
				// and save everything". Without this, users who
				// highlighted a value but didn't press Enter would
				// hit S and lose their selection — the v0.5.8 bug.
				//
				// The `closeModal` side-effect on /config commit
				// reliably closes the parent-refresh picker that the
				// first dispatch (set) emits, so the user exits cleanly.
				save := m.picker.OnSave()
				if save == "" {
					return m, m.respond(nil)
				}
				if m.baseURL == "" {
					m.picker = nil
					m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
					return m, m.respond(nil)
				}
				saveName, saveArgs := splitConfigBackCommand(save)
				// Apply the current selection first when one exists.
				// `Selected()` returns false on empty pickers (e.g., the
				// "Advanced (unmanaged)" group with no items); we just
				// dispatch save in that case.
				if value, ok := m.picker.Selected(); ok {
					selectCmd := m.picker.Command()
					m.picker = nil
					m.live.SetRunningCommand(m.theme.DimStyle().Render("…saving"))
					return m, m.respond(tea.Sequence(
						dispatchCommandCmd(m.baseURL, m.sessionID, selectCmd, value),
						dispatchCommandCmd(m.baseURL, m.sessionID, saveName, saveArgs),
					))
				}
				m.picker = nil
				m.live.SetRunningCommand(m.theme.DimStyle().Render("…saving"))
				return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, saveName, saveArgs))
			case "backspace":
				// 2026-05-24 patch — back-navigation. The payload's
				// optional OnBack carries the parent menu's command;
				// re-dispatch it so the user climbs the menu hierarchy
				// without re-running /config. When OnBack is absent
				// (root menu / non-hierarchical picker), backspace
				// is a no-op.
				back := m.picker.OnBack()
				if back == "" {
					return m, m.respond(nil)
				}
				m.picker = nil
				if m.baseURL == "" {
					m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
					return m, m.respond(nil)
				}
				m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + back))
				name, args := splitConfigBackCommand(back)
				return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, name, args))
			}
			return m, m.respond(nil)
		}
		// 2026-05-24 (config UX rebuild) — input card routing. Mirrors
		// the picker contract: Enter dispatches `<command> <value>`,
		// Esc cancels (quiet "(cancelled)" marker), other keys forward
		// to the embedded textinput so typing populates the value. The
		// inputCard absorbs ALL keys while open, matching the picker /
		// permission-modal input-lock pattern.
		if m.inputCard != nil {
			switch msg.String() {
			case "enter":
				value := m.inputCard.Value()
				cmdName := m.inputCard.Command()
				m.inputCard = nil
				if m.baseURL == "" {
					m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
					return m, m.respond(nil)
				}
				m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + cmdName + " " + value))
				return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, cmdName, value))
			case "esc":
				// 2026-05-24 patch — when the inputCard payload carries
				// an OnBack command (any /config edit case), Esc closes
				// the editor and re-dispatches that command so the user
				// returns to the parent submenu instead of being dumped
				// to scrollback. Falls back to the legacy "(cancelled)"
				// marker when OnBack is absent. In configOnly mode,
				// after the close we check for the "no modal" exit
				// condition.
				back := m.inputCard.OnBack()
				if back != "" {
					m.inputCard = nil
					if m.baseURL == "" {
						m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
						return m, m.respond(nil)
					}
					m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + back))
					name, args := splitConfigBackCommand(back)
					return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, name, args))
				}
				m.inputCard = nil
				if !m.configOnly {
					m.print(m.theme.DimStyle().Render("(cancelled)"))
				}
				return m, m.maybeQuitAfterModalClose(m.respond(nil))
			}
			// Forward all other keys to the embedded textinput so the
			// user can type the value. The Update returns a Cmd (cursor
			// blink tick); thread it through respond so it lands.
			updated, cmd := m.inputCard.Update(msg)
			*m.inputCard = updated
			return m, m.respond(cmd)
		}
		// ux-fixes round 5 — the round-4 PgUp/Shift+Arrow scroll
		// bindings are gone. With the alt screen dropped, the terminal
		// owns scrollback natively — wheel + trackpad just work.
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
				return m, m.respond(nil)
			case "up":
				m.autocomplete.MoveUp()
				return m, m.respond(nil)
			case "down":
				m.autocomplete.MoveDown()
				return m, m.respond(nil)
			case "esc":
				m.autocomplete.Dismiss()
				return m, m.respond(nil)
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
		// ux-fixes round 4 — ESC behavior split. Ctrl+C still tears down
		// the session. ESC during a streaming turn fires the per-turn
		// cancel endpoint and stays alive so the user can pivot
		// mid-flight (matches Claude Code). ESC while idle is a no-op
		// — explicit quit goes through Ctrl+C or /quit.
		if msg.String() == "ctrl+c" {
			m.cancel()
			return m, tea.Quit
		}
		if msg.Type == tea.KeyEsc {
			// Streaming = turn in flight on the server. thinkingPending
			// is set at submit time and may have already been cleared by
			// the first text_delta — checking both gives the broadest
			// "turn in flight" window so ESC works during both the
			// pre-content thinking wait and active streaming.
			if m.statusLine.Streaming || m.thinkingPending {
				m.userCancelledTurn = true
				m.print(
					m.theme.DimStyle().Render("(interrupted by user)"),
				)
				m.clearThinkingIfPending()
				return m, m.cancelTurnCmd()
			}
			return m, m.respond(nil)
		}
		// ux-fixes round 3 — Alt+Enter and Ctrl+J insert a real newline
		// into the prompt textarea instead of submitting. They flow
		// through to the textarea via the catch-all delegation at the
		// bottom of this branch. Plain Enter remains the submit key.
		if msg.Type == tea.KeyEnter && !msg.Alt {
			// ux-fixes round 4 — expand any "[Pasted text #N +M lines]"
			// placeholders back to the original pasted content before
			// trimming and dispatch. The user composed against the
			// abstracted view; the server / model see the real text.
			text := strings.TrimSpace(m.prompt.ExpandPastes(m.prompt.Value()))
			if text == "" {
				return m, m.respond(nil)
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
				m.printUser(text)
				m.prompt.Clear()
				dimStyle := lipgloss.NewStyle().
					Foreground(lipgloss.Color("#6e7681")).
					Italic(true)
				// ux-fixes round 5 — "[compacting…]" lives in the live
				// region until compactCompleteMsg / compactErrorMsg
				// clears it (replacing it with the real result line).
				m.live.SetRunningCommand(dimStyle.Render("[compacting…]"))
				return m, m.respond(m.compactCmd())
			}
			// M8 T6 — /expand [N] interception. Re-renders the Nth-most-recent
			// tool block from the local ring buffer with no truncation. Purely
			// client-side — no POST is fired. The echo line uses the same "» "
			// prefix as a normal turn so the user sees what they typed; the
			// expandToolBlock call appends the rendered block (or an error
			// marker if N is out of range) below it. No "[thinking]" placeholder
			// because there's no network round trip.
			if n, ok := parseExpandCommand(text); ok {
				m.printUser(text)
				m.prompt.Clear()
				return m, m.expandToolBlock(n)
			}
			// M9.6 T3 — /skills <verb> subcommand parser. Must run BEFORE
			// the /skillname matcher below so the literal /skills text is
			// captured as a subcommand instead of being treated as a (non-
			// existent) skill named "skills". ADR M9.6-03.
			// M11.17 — verbs: install <path>, uninstall <name>, reload, list.
			if text == "/skills" || strings.HasPrefix(text, "/skills ") {
				m.printUser(text)
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
						m.print(m.theme.DimStyle().Render("skills cache unavailable (no server)"))
						return m, m.respond(nil)
					}
					m.print(m.theme.DimStyle().Render("reloading skill cache…"))
					return m, m.fetchSkillsCmd()
				case "install":
					if m.baseURL == "" {
						m.print(m.theme.ErrorStyle().Render("skills install requires a server connection"))
						return m, m.respond(nil)
					}
					if verbArg == "" {
						m.print(m.theme.DimStyle().Render("usage: /skills install <path-to-SKILL.md-or-directory>"))
						return m, m.respond(nil)
					}
					m.print(m.theme.DimStyle().Render("installing skill from " + verbArg + "…"))
					return m, m.installSkillCmd(verbArg)
				case "uninstall":
					if m.baseURL == "" {
						m.print(m.theme.ErrorStyle().Render("skills uninstall requires a server connection"))
						return m, m.respond(nil)
					}
					if verbArg == "" {
						m.print(m.theme.DimStyle().Render("usage: /skills uninstall <name>"))
						return m, m.respond(nil)
					}
					m.print(m.theme.DimStyle().Render("uninstalling skill " + verbArg + "…"))
					return m, m.uninstallSkillCmd(verbArg)
				case "list", "":
					// Render the cached skill list directly — no server round trip.
					if len(m.skills) == 0 {
						m.print(m.theme.DimStyle().Render("no skills loaded for this session"))
					} else {
						m.print(m.theme.DimStyle().Render(fmt.Sprintf("skills (%d):", len(m.skills))))
						for _, sk := range m.skills {
							m.print("  /" + sk.Name + "  " + m.theme.DimStyle().Render(sk.Description))
						}
					}
					m.print("")
					m.print(m.theme.DimStyle().Render("verbs: /skills [list] | install <path> | uninstall <name> | reload"))
				default:
					m.print(m.theme.ErrorStyle().Render("unknown /skills verb: " + verb))
					m.print(m.theme.DimStyle().Render("verbs: list, install <path>, uninstall <name>, reload"))
				}
				return m, m.respond(nil)
			}
			// M8 T6 — /skillname interception. When the slash matches a
			// cached skill name (populated by fetchSkillsCmd on boot), POST
			// to /turns with `kind: 'skill'` so the server-side T5 handler
			// expands the prompt via expandSkillPrompt before saveMessage.
			// On no-match the input falls through to the normal turn POST
			// — the user might be typing a future slash command or a
			// literal /-prefixed string the model should see as-is.
			if name, ok := matchSkillSlash(text, m.skills); ok {
				m.printUser(text)
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
				for range style.S.Echo.LeadingGap {
					m.print("")
				}
				m.printUser(text)
				m.prompt.Clear()
				m.autocomplete.Dismiss()
				if m.baseURL == "" {
					m.print(m.theme.DimStyle().Render("slash-command unavailable (no server)"))
					return m, m.respond(nil)
				}
				m.live.SetRunningCommand(m.theme.DimStyle().Render("…running /" + cmdName))
				return m, m.respond(dispatchCommandCmd(m.baseURL, m.sessionID, cmdName, cmdArgs))
			}
			for range style.S.Echo.LeadingGap {
				m.print("")
			}
			m.printUser(text)
			for range style.S.Echo.TrailingGap {
				m.print("")
			}
			m.prompt.Clear()
			// M11.2 — branded thinking spinner replaces the static dim
			// "…thinking" placeholder. The spinner advances every 80ms
			// via spinnerTickMsg until clearThinkingIfPending bumps
			// m.spinnerGen on the first response event.
			m.thinkingPending = true
			spinCmd := m.startSpinner("thinking")
			return m, m.respond(tea.Batch(m.submitTurn(text), spinCmd))
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
		return m, m.respond(cmd)
	case tea.MouseMsg:
		// ux-fixes round 5 — mouse capture is off entirely. The terminal
		// handles wheel + click natively (scroll + text selection). Any
		// MouseMsg that does arrive (e.g. an unfiltered tmux session)
		// is a no-op; the in-TUI toolcard click interaction was retired
		// with the inline-mode refactor.
		_ = msg
		return m, m.respond(nil)
	case sseMsg:
		eventCmd := m.handleEvent(msg.env)
		// ux-fixes round 5 — drain any Println output the handler queued
		// alongside the next-event waiter. tea.Batch preserves visibility;
		// Println goes to the terminal's output stream and the waiter
		// continues blocking on m.events.
		return m, m.respond(tea.Batch(m.waitEvent, eventCmd))
	case stallExpireMsg:
		// M9.6 T2: clear the badge only if no NEWER stall has arrived.
		// Stale ticks (older gen than current) are no-ops; the newer
		// stall's own tick will clear the refreshed badge.
		if msg.gen == m.stallGeneration {
			m.stallBadge = nil
		}
		return m, m.respond(nil)
	case spinnerTickMsg:
		// M11.2: animate the thinking spinner. Drop stale ticks
		// (gen mismatch means clearThinkingIfPending invalidated us
		// or a newer startSpinner ran). When still current, advance
		// the frame, update the line in place, and schedule the
		// next tick — recurring chain that stops naturally on the
		// next clearThinkingIfPending.
		if msg.gen != m.spinnerGen || m.spinnerLineIdx < 0 || !m.thinkingPending {
			return m, m.respond(nil)
		}
		m.spinner = m.spinner.Tick()
		m.live.SetSpinner(m.spinner.View(m.spinnerLabel))
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
			return m, m.respond(nil)
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
			return m, m.respond(nil)
		}
		streamURL := fmt.Sprintf("%s/sessions/%s/events", m.baseURL, m.sessionID)
		m.events, m.errs = transport.Consume(m.ctx, streamURL)
		return m, m.waitEvent
	case turnSubmitErrMsg:
		m.print(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#e06c75")).
				Render(fmt.Sprintf("submit error: %v", msg.err)),
		)
		return m, m.respond(nil)
	case messagesFetchedMsg:
		if msg.err != nil {
			m.print(
				lipgloss.NewStyle().
					Foreground(lipgloss.Color("#6e7681")).
					Italic(true).
					Render(fmt.Sprintf("could not load prior messages: %v", msg.err)),
			)
			return m, m.respond(nil)
		}
		// Hydrate prior messages into terminal scrollback so the resumed
		// session reads identically to a fresh one — user lines first,
		// assistant text after, in transcript order. tool_use / tool_result
		// historical rendering is deferred to M7 when trajectory capture
		// lands richer hydration.
		for _, sm := range msg.messages {
			for _, block := range sm.Content {
				if block.Type != "text" || block.Text == "" {
					continue
				}
				switch sm.Role {
				case "user":
					m.printUser(block.Text)
				case "assistant":
					m.print(block.Text)
				}
			}
		}
		return m, m.respond(nil)
	case components.PermissionSubmitMsg:
		// M5 T9: user's choice has been captured; clear the modal and POST
		// the decision back to the server. The runtime's serverAsk awaits
		// /sessions/:id/approvals/:requestId and resumes the paused turn.
		m.permission = nil
		return m, m.postApproval(msg)
	case compactCompleteMsg:
		// ux-fixes round 5 — clear the "[compacting…]" live indicator.
		// Pre-refactor this called transcript.RemoveLastLine to pop the
		// placeholder; the placeholder now lives in the LiveRegion as a
		// running-command indicator.
		m.live.SetRunningCommand("")
		dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681"))
		if msg.noOp {
			m.print(dim.Render("─ nothing to compact (history already fits)"))
			return m, m.respond(nil)
		}
		m.sessionID = msg.activeSessionID
		m.print(dim.Render(fmt.Sprintf("─ compacted — new session %s", shortSessionID(msg.activeSessionID))))
		return m, m.respond(nil)
	case compactErrorMsg:
		m.live.SetRunningCommand("")
		m.print(
			lipgloss.NewStyle().
				Foreground(lipgloss.Color("#e06c75")).
				Render(fmt.Sprintf("compact failed: %v", msg.err)),
		)
		return m, m.respond(nil)
	case skillsFetchedMsg:
		// M8 T6: store the cached skill list. On failure we surface a dim
		// line and continue — the slash intercept falls through to normal
		// turn dispatch when m.skills is empty, so the TUI stays usable
		// even if the /skills route is offline. No visible marker on
		// success — the cache is silently warmed.
		if msg.err != nil {
			m.print(
				lipgloss.NewStyle().
					Foreground(lipgloss.Color("#6e7681")).
					Italic(true).
					Render(fmt.Sprintf("could not load skills: %v", msg.err)),
			)
			return m, m.respond(nil)
		}
		m.skills = msg.skills
		m.autocomplete.SetSkills(msg.skills) // M9 T8 — surface skills in the popup
		return m, m.respond(nil)
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
		return m, m.respond(nil)
	case skillInstalledMsg:
		// M11.17 — render install result and refresh the skill cache on
		// success so the new skill becomes available immediately for
		// /skillname dispatch + autocomplete suggestions.
		if msg.err != nil {
			m.print(m.theme.ErrorStyle().Render("skill install failed: " + msg.err.Error()))
			return m, m.respond(nil)
		}
		if msg.result == nil {
			m.print(m.theme.ErrorStyle().Render("skill install returned no result"))
			return m, m.respond(nil)
		}
		m.print(m.theme.DimStyle().Render(
			fmt.Sprintf("installed /%s → %s", msg.result.Name, msg.result.InstalledAt),
		))
		return m, m.fetchSkillsCmd()
	case skillUninstalledMsg:
		// M11.17 — render uninstall result and refresh the skill cache.
		if msg.err != nil {
			m.print(m.theme.ErrorStyle().Render("skill uninstall failed: " + msg.err.Error()))
			return m, m.respond(nil)
		}
		if msg.result == nil {
			m.print(m.theme.ErrorStyle().Render("skill uninstall returned no result"))
			return m, m.respond(nil)
		}
		m.print(m.theme.DimStyle().Render(
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
		// ux-fixes round 5 — clear the "…running /name" live indicator.
		m.live.SetRunningCommand("")
		if msg.err != nil {
			m.print(
				lipgloss.NewStyle().
					Foreground(lipgloss.Color("#e06c75")).
					Render(fmt.Sprintf("/%s failed: %v", msg.name, msg.err)),
			)
			return m, m.respond(nil)
		}
		if msg.resp != nil && msg.resp.Error != "" {
			m.print(
				lipgloss.NewStyle().
					Foreground(m.theme.Warning).
					Bold(true).
					Render(msg.resp.Error),
			)
			return m, m.respond(nil)
		}
		// M11.5 — pickerOpen side-effect opens an inline card. Picker
		// payloads typically come with empty output; if non-empty, we
		// still render it as a label above the card.
		if msg.resp != nil && msg.resp.SideEffects != nil && msg.resp.SideEffects.PickerOpen != nil {
			if msg.resp.Output != "" {
				for _, line := range strings.Split(msg.resp.Output, "\n") {
					m.print(line)
				}
			}
			picker := components.NewPickerCard(*msg.resp.SideEffects.PickerOpen, m.theme)
			m.picker = &picker
			return m, m.respond(nil)
		}
		// 2026-05-24 (config UX rebuild) — inputOpen side-effect opens
		// an inline text input. Mirrors the pickerOpen pattern. The
		// active picker (if any) is cleared so the input replaces it
		// — `/config edit <stringField>` from a submenu picker should
		// hand off cleanly to the editor card.
		if msg.resp != nil && msg.resp.SideEffects != nil && msg.resp.SideEffects.InputOpen != nil {
			if msg.resp.Output != "" {
				for _, line := range strings.Split(msg.resp.Output, "\n") {
					m.print(line)
				}
			}
			m.picker = nil
			input := components.NewInputCard(*msg.resp.SideEffects.InputOpen, m.theme)
			m.inputCard = &input
			return m, m.respond(nil)
		}
		if msg.resp != nil && msg.resp.Output != "" {
			// Append each output line individually so transcript scroll
			// math stays accurate (Transcript.AppendLine is single-line).
			for _, line := range strings.Split(msg.resp.Output, "\n") {
				m.print(line)
			}
		}
		// Apply sideEffects. SessionID pivot (newSessionId) and exit
		// signals fire even on empty output. Note: StatusLine doesn't
		// dynamically render the model (M2 fixed-field design); the
		// model change is visible via the command's output text — no
		// statusline mutation needed in M10.5.
		var clearScrollbackPending bool
		if msg.resp != nil && msg.resp.SideEffects != nil {
			se := msg.resp.SideEffects
			// 2026-05-24 patch — /clear scrollback wipe. We need to
			// process this BEFORE NewSessionID's print so the splash
			// re-emission below lands AFTER the clear (everything
			// queued via m.print after this drains via tea.Println
			// once the clear Cmd has run). Splash + the session
			// marker land in the now-empty terminal scrollback.
			if se.ClearScrollback != nil && *se.ClearScrollback {
				clearScrollbackPending = true
				m.splashShown = false
				m.emitSplash(m.width)
			}
			if se.NewSessionID != "" {
				m.sessionID = se.NewSessionID
				m.print(
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
					m.print(
						m.theme.DimStyle().Render(
							fmt.Sprintf("could not apply theme '%s' client-side: %v", se.ThemeChanged, err),
						),
					)
				}
			}
			// ux-fixes 2026-05-22 (ux3.png): /model side-effect updates
			// the server's resolvedProvider.model but the bottom status
			// line was still showing the boot-time model name. Mirror
			// the change into m.statusLine.Model so the next render
			// reflects the new model. (The server's command response
			// already wrote the user-visible "model set to <name>"
			// line into scrollback; this just refreshes the chrome.)
			if se.ModelChanged != "" {
				m.statusLine.Model = se.ModelChanged
			}
			// 2026-05-24 (config UX rebuild) — verboseChanged side-effect
			// applies the new verbose flag live. `false` flips the
			// toolcard renderer back to compact mode (verboseRaw=false);
			// `true` enables the raw-output escape hatch. Pointer-typed
			// on the wire so nil (absent) is distinct from `false`.
			// Re-rendering finalized tool cards already in scrollback is
			// out of scope — future tool_results pick up the new mode.
			if se.VerboseChanged != nil {
				m.verboseRaw = *se.VerboseChanged
			}
			if se.TaskRouterChanged != nil {
				m.statusLine.TaskRouter = *se.TaskRouterChanged
			}
			// 2026-05-24 patch — explicit close-modal signal from
			// /config commit / /config discard. Clears any picker /
			// input card so the S-as-apply-then-save flow exits
			// cleanly. The toast (msg.resp.Output) still prints via
			// the regular output handler below.
			if se.CloseModal != nil && *se.CloseModal {
				m.picker = nil
				m.inputCard = nil
			}
			if se.ExitRequested {
				return m, tea.Quit
			}
		}
		// Prompt-type slash commands (/init, /commit, every skill-sourced
		// command) carry the expanded prompt body in PromptToSend. Auto-
		// fire it as a turn so the user doesn't have to re-type it.
		// Mirrors sov drive at src/cli/driveCommand.ts:475. The output
		// field has already rendered the body so no extra echo is needed.
		if msg.resp != nil && msg.resp.PromptToSend != "" && m.baseURL != "" {
			m.thinkingPending = true
			spinCmd := m.startSpinner("thinking")
			return m, m.wrapClearScrollback(
				clearScrollbackPending,
				m.respond(tea.Batch(m.submitTurn(msg.resp.PromptToSend), spinCmd)),
			)
		}
		return m, m.wrapClearScrollback(clearScrollbackPending, m.maybeQuitAfterModalClose(m.respond(nil)))
	}
	// ux-fixes round 5 — no transcript forwarding for unhandled msgs.
	// History lives in terminal scrollback; nothing reroutes here.
	return m, m.respond(nil)
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
	m.live.SetTheme(m.theme)
	m.autocomplete.SetTheme(m.theme)
	m.statusLine.SetTheme(m.theme)
	if m.picker != nil {
		m.picker.SetTheme(m.theme)
	}
	if m.inputCard != nil {
		m.inputCard.SetTheme(m.theme)
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
		m.live.AppendAssistantDelta(td.Text)
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
		m.print(
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
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
	case "tool_result":
		tr, err := transport.DecodeToolResult(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
		hint := tr.RenderHint
		if hint == "" {
			hint = "text"
		}
		// M9 T5 — detect FileEdit / FileWrite and parse the output as a
		// unified diff. If hunks are present, the DiffView is kept on
		// hand for detailed-mode rendering and for Ctrl+] focus routing.
		// (Compact mode uses its own diff-stat extractor in
		// components.FormatCompactToolLine.)
		var diff *components.DiffView
		if tr.Tool == "FileEdit" || tr.Tool == "FileWrite" {
			dv := components.NewDiffView(string(tr.Output), m.theme)
			if dv.HasHunks() {
				diff = &dv
				m.mostRecentDiff = diff
			}
		}

		// ux-fixes 2026-05-22 — branch on the tool-output mode. compact
		// mode (default) emits a single line per tool_result; detailed
		// mode emits the existing bordered ToolCard. The -v / --verbose
		// flag (m.verboseRaw) is orthogonal — when set, the raw
		// untruncated output prints below either rendering. Spec:
		// docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
		switch m.toolOutputMode {
		case "detailed":
			card := components.ToolCard{
				Tool:        tr.Tool,
				RenderHint:  hint,
				Summary:     fmt.Sprintf("rendered as %s", hint),
				Input:       string(tr.Input),
				Output:      string(tr.Output),
				Language:    tr.Language,
				Theme:       m.theme,
				Expanded:    true,
				Diff:        diff,
				InlineLines: m.toolOutputInlineLines,
			}
			m.print(card.View(m.width))
		default: // "compact"
			m.print(components.FormatCompactToolLine(
				tr.Tool, tr.Input, tr.Output, m.theme, m.width,
			))
		}

		// Orthogonal raw escape hatch — print full untruncated output
		// below either mode's rendering. Dim/italic so the eye reads it
		// as appended debug rather than primary content.
		if m.verboseRaw && len(tr.Output) > 0 {
			raw := lipgloss.NewStyle().
				Foreground(m.theme.Dim).
				Italic(true).
				Render(string(tr.Output))
			m.print(raw)
		}

		// M8 T6 — record the block onto the local ring for /expand [N]
		// re-render. The wire `output` is json.RawMessage so we render
		// it as a string verbatim; the expand path treats it as plain
		// text (multi-line splits on \n) which matches how the user
		// would read raw tool output in a debug log.
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
		// ux-fixes round 4 — when the user triggered the abort via ESC
		// (POST /cancel), the server's catch block emits a turn_error
		// carrying the AbortError message. We already displayed
		// "(interrupted by user)" inline before firing the cancel —
		// stack a red "⚠ turn error: AbortError" on top would be
		// misleading. Swallow this one turn_error and reset the flag so
		// the next genuine error (next turn) renders normally.
		if m.userCancelledTurn {
			m.userCancelledTurn = false
			return nil
		}
		errStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#f7768e")).
			Bold(true)
		m.print(errStyle.Render("⚠ turn error: " + te.Error))
		if !te.Recoverable {
			m.print(errStyle.Render("  (non-recoverable)"))
		}
	case "turn_complete":
		// ux-fixes round 4 — clear any pending userCancelledTurn flag.
		// If the user pressed ESC but the turn completed normally
		// before the abort propagated, we don't want the next genuine
		// error to be swallowed.
		m.userCancelledTurn = false
		tc, err := transport.DecodeTurnComplete(env.Raw)
		if err != nil {
			// Schema parse failed — still surface a separator so the
			// user sees turn boundaries; failure mode degrades to the
			// same visual as a normal end_turn.
			m.clearThinkingIfPending()
			if rendered, ok := m.live.EndAssistantCard(); ok {
				m.print(rendered)
			}
			m.print(turnSeparator(m.theme, m.width))
			return nil
		}
		m.clearThinkingIfPending()
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
		// M11.7 — pure separator line, no text. Previously rendered
		// "─ turn complete" / "─ turn complete (max_tokens)" which read
		// as system noise between conversational turns. Now: a single
		// dim horizontal rule, with the finish reason surfaced ONLY
		// when it's something the user should notice (non-end_turn).
		if tc.FinishReason == "" || tc.FinishReason == "end_turn" {
			m.print(turnSeparator(m.theme, m.width))
		} else {
			dim := lipgloss.NewStyle().Foreground(m.theme.Dim).Italic(true)
			m.print(turnSeparator(m.theme, m.width))
			m.print(dim.Render("  ⚠ " + tc.FinishReason))
		}
		for range style.S.Separator.TrailingGap {
			m.print("")
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
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
		m.sessionID = cc.ActiveSessionID
		m.print(components.RenderCompactionCard(
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
	case "delegator_plan":
		// Phase 2 T5 — Smart router synthesizes this when the delegator
		// sub-agent starts a turn. Print a "Delegating …" marker so the
		// user sees the boundary between "the parent decided to delegate"
		// and the atom-by-atom progress lines that follow.
		ev, err := transport.DecodeDelegatorPlan(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
		m.print("") // breathing room before delegator group
		m.print(components.FormatDelegatorPlanLine(ev, m.theme, m.width))
		m.print("") // space between plan header and atom events
	case "delegator_atom_started":
		// Phase 2 T5 — an atom dispatched onto a specific lane. Prints
		// the "→ atom N on <lane>: <preview>" line so the user can see
		// what work was farmed out and where.
		ev, err := transport.DecodeDelegatorAtomStarted(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
		m.print(components.FormatDelegatorAtomStartedLine(ev, m.theme, m.width, m.debugMode))
	case "delegator_atom_complete":
		// Phase 2 T5 — atom finished, success or failure. Renders the
		// "✓/✗ atom N on <lane> (<ms>ms)" terminal line.
		ev, err := transport.DecodeDelegatorAtomComplete(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
		m.print(components.FormatDelegatorAtomCompleteLine(ev, m.theme, m.width, m.debugMode))
	case "delegator_complete":
		// Phase 2 T5 — delegator turn finished. Prints the summary footer
		// with total atom count and the sorted per-lane distribution.
		ev, err := transport.DecodeDelegatorComplete(env.Raw)
		if err != nil {
			return nil
		}
		m.clearThinkingIfPending()
		if rendered, ok := m.live.EndAssistantCard(); ok {
			m.print(rendered)
		}
		m.print("") // space between atom events and summary footer
		m.print(components.FormatDelegatorCompleteLine(ev, m.theme, m.width))
		m.print("") // breathing room after delegator group
	}
	return nil
}

// handleMouseClick is retained as a stub for any caller that still
// references it. ux-fixes round 5 dropped mouse capture entirely so no
// MouseMsg should arrive in practice; this kept-for-compile shim
// ensures incidental references don't break the build.
func (m Model) handleMouseClick(_ tea.MouseMsg) (Model, tea.Cmd) {
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
	m.live.ClearSpinner()
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
	m.live.SetSpinner(m.spinner.View(label))
	m.spinnerLineIdx = 0 // legacy bookkeeping; LiveRegion holds the actual state now
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
	rule := strings.Repeat(style.S.Separator.Char, n)
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

	// ux-fixes round 5 — inline mode View. Committed transcript history
	// flows into the terminal's native scrollback via tea.Println
	// (m.print / m.drainPrintln) — no longer rendered inside View().
	// The live region holds whatever is in-flight (streaming assistant
	// card, "(running command)" indicator, thinking spinner). Stall
	// badge and picker card stack above the prompt as before.
	var b strings.Builder
	if live := m.live.View(); live != "" {
		b.WriteString(live)
		if !strings.HasSuffix(live, "\n") {
			b.WriteString("\n")
		}
	}
	if m.stallBadge != nil {
		b.WriteString(m.stallBadge.View(m.width))
		b.WriteString("\n")
	}
	if m.picker != nil {
		b.WriteString(m.picker.View(m.width))
		b.WriteString("\n")
	}
	if m.inputCard != nil {
		b.WriteString(m.inputCard.View(m.width))
		b.WriteString("\n")
	}
	// 2026-05-24 patch — in `sov config` standalone mode the prompt
	// input + status line are hidden so the user doesn't mistake the
	// editor process for an active agent session. The splash + active
	// picker / inputCard remain. A short footer hint replaces the
	// status line so users know how to exit.
	if m.configOnly {
		b.WriteString("\n")
		footer := lipgloss.NewStyle().
			Foreground(m.theme.Dim).
			Italic(true).
			Render("Sovereign AI — config · esc on the root menu exits")
		b.WriteString(footer)
		b.WriteString("\n")
		return b.String()
	}
	b.WriteString("\n")
	b.WriteString(prompt)
	b.WriteString("\n")
	if hint != "" {
		b.WriteString(hint)
		b.WriteString("\n")
	}
	b.WriteString(m.statusLine.View())
	return b.String()
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
