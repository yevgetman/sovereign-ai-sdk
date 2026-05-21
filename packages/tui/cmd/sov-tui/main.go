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
		mouse     = flag.Bool("mouse", false, "enable mouse capture for clicks + wheel-scroll (disables native terminal text selection)")
		noMouse   = flag.Bool("no-mouse", false, "deprecated no-op: mouse is now off by default; use --mouse to opt in")
		modelName = flag.String("model", "", "model name to display in the splash and status line")
		provider  = flag.String("provider", "", "provider name to display in the splash and status line")
	)
	flag.Parse()
	_ = noMouse // accepted for back-compat with older `sov` launchers

	if *version {
		fmt.Println(versionString())
		return
	}
	if *port == 0 || *sessionID == "" {
		fmt.Fprintln(os.Stderr, "sov-tui: --port and --session-id are required")
		os.Exit(2)
	}

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", *port)
	model := app.New(*sessionID, baseURL).WithSessionInfo(*modelName, *provider)
	// Mouse capture is OFF by default so terminal-native text selection
	// (click-drag to highlight, Cmd+C / Ctrl+Shift+C to copy) works
	// everywhere out of the box. Users who want click + wheel-scroll
	// inside the TUI opt in with --mouse. ux-fixes round 3.
	opts := []tea.ProgramOption{tea.WithAltScreen()}
	if *mouse || os.Getenv("SOV_MOUSE") == "1" {
		opts = append(opts, tea.WithMouseCellMotion())
	}
	prog := tea.NewProgram(model, opts...)
	if _, err := prog.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "sov-tui: %v\n", err)
		os.Exit(1)
	}
}
