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
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
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
		noMouse   = flag.Bool("no-mouse", false, "disable mouse mode (for terminals that mishandle mouse escape codes)")
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

	// M11.7 — force the lipgloss renderer to truecolor. termenv's
	// auto-detection is unreliable when TERM=screen-256color (typical
	// inside tmux/screen) because it reads TERM instead of COLORTERM
	// in some paths. Forcing TrueColor here means our hex colors emit
	// actual 24-bit RGB ANSI sequences (`\033[38;2;R;G;Bm`) which
	// every modern terminal handles correctly, instead of being
	// quantized to the nearest 256-color entry which can land on a
	// dim greyscale step. If the underlying terminal genuinely can't
	// display truecolor it'll still degrade gracefully — the worst
	// case is what we'd have gotten by auto-detection anyway.
	lipgloss.DefaultRenderer().SetColorProfile(termenv.TrueColor)

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", *port)
	model := app.New(*sessionID, baseURL)
	// M9.6 T1: --no-mouse opts out of mouse-mode escape sequences for
	// terminals that mishandle them. ADR M9.6-01: click v1 is limited to
	// toolcard + autocomplete; wheel-scroll is M9's only mouse behavior.
	opts := []tea.ProgramOption{tea.WithAltScreen()}
	if !*noMouse {
		opts = append(opts, tea.WithMouseCellMotion())
	}
	prog := tea.NewProgram(model, opts...)
	if _, err := prog.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "sov-tui: %v\n", err)
		os.Exit(1)
	}
}
