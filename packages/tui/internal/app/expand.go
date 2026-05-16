// Package app — M8 T6 /expand [N] interception + completed-block ring.
//
// `/expand [N]` re-renders the Nth-most-recent tool block from a local
// ring buffer with no truncation. N defaults to 1 (most recent). The
// ring is capped at `completedBlocksCap` to bound memory across long
// sessions — when full, the oldest entry is evicted on each new push.
//
// The ring is populated from the SSE `tool_result` handler in app.go.
// /expand is intentionally a client-side surface — no server round trip;
// the data is already in the TUI's hands and re-rendering it costs
// nothing past the lipgloss frame rebuild.
//
// parseExpandCommand returns (n, ok). ok=false branches the dispatch
// path back to the normal slash handling — the input either isn't an
// /expand command (the leading "expand" doesn't match) or N is invalid
// (non-integer, ≤ 0). The TUI never panics on a bad /expand input; the
// worst case surfaces a dim "no tool block to expand" marker.

package app

import (
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"
	tea "github.com/charmbracelet/bubbletea"
)

// completedBlocksCap bounds the ring buffer at 50 entries. Past that,
// /expand 51 is meaningless (the buffer doesn't go that far back) and
// the rendered transcript would have scrolled past the block anyway.
// The cap also bounds long-session memory — each entry holds the raw
// tool output which can be multi-KB.
const completedBlocksCap = 50

// CompletedBlock is one tool_result entry retained for /expand re-render.
// Output is the raw JSON-encoded output payload from the SSE event.
// IsError is reserved for future tool-error classification; defaults to
// false today (tool_result events don't currently flag errors on the
// wire — the runtime promotes them to turn_error instead).
type CompletedBlock struct {
	Seq     int64
	Tool    string
	Output  string
	IsError bool
}

// parseExpandCommand parses "/expand" or "/expand N" → (n, ok).
// Defaults to 1 when no arg. Returns ok=false on non-positive ints,
// non-numeric arg, or any input that isn't exactly /expand (no longer
// prefix like /expander).
func parseExpandCommand(input string) (int, bool) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "/expand" {
		return 1, true
	}
	const prefix = "/expand "
	if !strings.HasPrefix(trimmed, prefix) {
		return 0, false
	}
	rest := strings.TrimSpace(trimmed[len(prefix):])
	if rest == "" {
		return 1, true
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// appendCompletedBlock pushes a tool_result entry onto the ring. When
// the ring is at `completedBlocksCap` the oldest entry is evicted (slice
// shift — the slice stays a contiguous window over the most recent N
// blocks, which keeps the lookup math trivial).
func (m *Model) appendCompletedBlock(block CompletedBlock) {
	if len(m.completedBlocks) >= completedBlocksCap {
		// Drop the oldest. copy + shrink rather than reslicing so the
		// underlying array doesn't grow unbounded across long sessions.
		copy(m.completedBlocks, m.completedBlocks[1:])
		m.completedBlocks = m.completedBlocks[:len(m.completedBlocks)-1]
	}
	m.completedBlocks = append(m.completedBlocks, block)
}

// lookupCompletedBlock returns the Nth-most-recent block. N=1 is the
// most recent; N=len(completedBlocks) is the oldest retained. Returns
// ok=false for N <= 0 or N > len so the dispatch path can render an
// error marker rather than panicking on a negative index.
func (m *Model) lookupCompletedBlock(n int) (CompletedBlock, bool) {
	if n <= 0 || n > len(m.completedBlocks) {
		return CompletedBlock{}, false
	}
	return m.completedBlocks[len(m.completedBlocks)-n], true
}

// expandToolBlock re-renders the Nth-most-recent tool block into the
// transcript with no truncation. The dispatch is purely client-side —
// the SSE-streamed tool_result already populated the ring, so re-render
// costs nothing past the lipgloss frame rebuild. Returns a nil tea.Cmd
// because there's nothing async to schedule — the transcript mutation
// has already happened by the time this returns.
func (m *Model) expandToolBlock(n int) tea.Cmd {
	dim := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681")).Italic(true)
	block, ok := m.lookupCompletedBlock(n)
	if !ok {
		total := len(m.completedBlocks)
		m.transcript.AppendLine(dim.Render(
			"no tool block to expand (requested " + strconv.Itoa(n) +
				", " + strconv.Itoa(total) + " available)",
		))
		return nil
	}
	// Header line — names the tool + position in the ring. Dim so the
	// expanded body itself remains the visual focus.
	total := len(m.completedBlocks)
	m.transcript.AppendLine(dim.Render(
		"(expanded) " + block.Tool + " · block " +
			strconv.Itoa(n) + " of " + strconv.Itoa(total),
	))
	// Output body — no truncation. The transcript is line-oriented so
	// multi-line output splits cleanly on \n. lipgloss handles wrapping
	// once the viewport's width is set.
	for _, line := range strings.Split(block.Output, "\n") {
		m.transcript.AppendLine(line)
	}
	return nil
}
