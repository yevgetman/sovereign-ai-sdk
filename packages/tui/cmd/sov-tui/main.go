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
	)
	flag.Parse()

	if *version {
		fmt.Println(versionString())
		return
	}
	if *port == 0 || *sessionID == "" {
		fmt.Fprintln(os.Stderr, "sov-tui: --port and --session-id are required")
		os.Exit(2)
	}

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", *port)
	model := app.New(*sessionID, baseURL)
	prog := tea.NewProgram(model, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := prog.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "sov-tui: %v\n", err)
		os.Exit(1)
	}
}
