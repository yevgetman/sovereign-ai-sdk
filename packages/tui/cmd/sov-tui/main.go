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
	model := app.New(*sessionID, baseURL).WithSessionInfo(*modelName, *provider, *harnessVersion)
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
