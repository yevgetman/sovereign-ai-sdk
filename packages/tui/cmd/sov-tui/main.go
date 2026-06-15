// sov-tui — Bubble Tea client for the Phase 16.1 sov harness.
//
// Connects to a running sov HTTP+SSE server at --port on 127.0.0.1, opens
// the SSE stream for --session-id, and renders the foreground TUI.

package main

import (
	"flag"
	"fmt"
	"os"
	"runtime/debug"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/app"
)

// versionString reports the module version baked into the binary by Go's
// build tooling. When the binary is run from a dev tree (no module info
// or `(devel)`), falls back to a sentinel so it's obvious that a real
// version isn't pinned yet.
func versionString() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return "sov-tui " + info.Main.Version
	}
	return "sov-tui 0.0.1-dev"
}

func main() {
	var (
		port      = flag.Int("port", 0, "server port on 127.0.0.1 (required)")
		sessionID = flag.String("session-id", "", "session ID (required)")
		version   = flag.Bool("version", false, "print version and exit")
		mouse     = flag.Bool("mouse", false, "deprecated no-op (terminal now owns scroll + selection natively); kept for back-compat with older launchers")
		noMouse   = flag.Bool("no-mouse", false, "deprecated no-op (mouse capture is gone after round 5 inline-mode refactor)")
		modelName      = flag.String("model", "", "model name to display in the splash and status line")
		provider       = flag.String("provider", "", "provider name to display in the splash and status line")
		harnessVersion = flag.String("harness-version", "", "harness runtime version (from src/version.ts) to display in the splash; empty falls back to a sentinel")
		// ux-fixes 2026-05-22 — tool-output rendering controls forwarded
		// from the launcher (which reads them from userSettings.ui.toolOutput).
		// Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
		toolOutputMode        = flag.String("tool-output-mode", "compact", "compact (default, one-line per tool call) or detailed (bordered card capped to --tool-output-inline-lines)")
		toolOutputInlineLines = flag.Int("tool-output-inline-lines", 10, "in detailed mode, cap each tool's inline output to this many rows + '…[+N more lines]' footer")
		verboseRaw            = flag.Bool("verbose-raw", false, "orthogonal escape hatch — print full untruncated raw tool output below the compact/detailed rendering")
		// 2026-05-24 (config UX rebuild) — initial slash command fired
		// once the splash is up. Used by `sov config` to launch the
		// TUI straight into `/config` without requiring user input.
		// Empty value (default) disables the behavior.
		initialCommand = flag.String("initial-command", "", "slash command to fire automatically once the TUI is up (e.g., '/config'); empty disables")
		// 2026-05-24 patch — `sov config` standalone mode. Hides the
		// prompt input + status line so the user doesn't mistake the
		// editor process for an active agent session, and exits
		// cleanly when no modal (picker / input card) is open.
		configOnly = flag.Bool("config-only", false, "config-editor mode: hide prompt + status, exit when no modal is open (used by `sov config`)")
		// 2026-05-24 patch — task-routing status. When non-empty,
		// the status-line profile column is replaced with "Task
		// Router Active (<preset>)" so users see at a glance that
		// routing is on. Value is the preset id (built-in or
		// user-saved) OR the literal string "custom" when no preset
		// matches the current lane configuration.
		taskRouter = flag.String("task-router", "", "task-routing status string (preset id or 'custom'); empty means routing is off")
		// 2026-05-24 patch — debug mode flag. When set, delegator
		// atom lines surface the resolved provider/model in brackets
		// after the lane name, so users see exactly which model
		// handled a given response.
		debugMode = flag.Bool("debug-mode", false, "render granular routing detail in delegator lines (lane provider/model)")
		// 2026-06-15 patch — subscription-executor posture. When set,
		// delegations route to a headless `claude -p
		// --dangerously-skip-permissions` subprocess (default
		// permissionMode 'bypass' — no approval gate), so the status
		// line renders a LOUD chip flagging the no-approval-gate posture.
		subscriptionExecutor = flag.Bool("subscription-executor", false, "render a loud status-line chip flagging that subscription-executor delegations run with no approval gate")
	)
	flag.Parse()
	_ = mouse   // accepted for back-compat
	_ = noMouse // accepted for back-compat

	if *version {
		fmt.Println(versionString())
		return
	}
	if *port == 0 || *sessionID == "" {
		fmt.Fprintln(os.Stderr, "sov-tui: --port and --session-id are required")
		os.Exit(2)
	}

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", *port)
	model := app.New(*sessionID, baseURL).
		WithSessionInfo(*modelName, *provider, *harnessVersion).
		WithToolOutput(*toolOutputMode, *toolOutputInlineLines).
		WithVerboseRaw(*verboseRaw).
		WithInitialCommand(*initialCommand).
		WithConfigOnly(*configOnly).
		WithTaskRouter(*taskRouter).
		WithSubscriptionExecutor(*subscriptionExecutor).
		WithDebugMode(*debugMode)
	// ux-fixes round 5 — inline mode. Drop the alt screen so transcript
	// content flows into the terminal's native scrollback (wheel scroll
	// + click-drag text selection just work). Drop mouse capture too —
	// the TUI doesn't need to intercept clicks; the terminal handles
	// scroll natively and the in-TUI tool-card click interaction was
	// retired with the refactor.
	prog := tea.NewProgram(model)
	if _, err := prog.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "sov-tui: %v\n", err)
		os.Exit(1)
	}
}
