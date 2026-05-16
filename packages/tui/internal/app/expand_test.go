// Package app — tests for the M8 T6 /expand [N] interception.
//
// Pins the parse contract for the /expand slash command. The TUI consumes
// the parse result to look up the Nth-most-recent tool block in the local
// ring buffer (model.completedBlocks) and re-render it without truncation.

package app

import "testing"

func TestParseExpandCommand(t *testing.T) {
	cases := []struct {
		input string
		ok    bool
		n     int
	}{
		{"/expand", true, 1},
		{"/expand 2", true, 2},
		{"/expand 10", true, 10},
		{"/expand foo", false, 0},
		{"/expand -1", false, 0},
		{"/expand 0", false, 0},
		// Trailing whitespace should not trip the parser — the prompt may
		// emit a trailing newline or space depending on input mode.
		{"/expand   3  ", true, 3},
		// Unknown slashes must not be treated as /expand.
		{"/compact", false, 0},
		{"/", false, 0},
		{"", false, 0},
		{"expand 1", false, 0},
		// Must NOT match a /skillname starting with the literal letters
		// "expand" — the slash-command match is exact on `/expand` plus a
		// space-or-EOL boundary.
		{"/expander 2", false, 0},
	}
	for _, tc := range cases {
		n, ok := parseExpandCommand(tc.input)
		if ok != tc.ok || n != tc.n {
			t.Errorf("parseExpandCommand(%q) = %d, %v; want %d, %v", tc.input, n, ok, tc.n, tc.ok)
		}
	}
}

// TestCompletedBlocksRing pins the M8 T6 ring buffer contract: the model
// accumulates tool_result entries up to the cap and evicts the oldest
// when full. /expand [N] indexes from the most recent — 1 = newest,
// len = oldest. Cap is 50.
func TestCompletedBlocksRing(t *testing.T) {
	m := Model{}
	for i := 0; i < 60; i++ {
		m.appendCompletedBlock(CompletedBlock{Seq: int64(i + 1), Tool: "FileRead", Output: "line"})
	}
	if got := len(m.completedBlocks); got != completedBlocksCap {
		t.Fatalf("len = %d, want %d", got, completedBlocksCap)
	}
	// After 60 inserts with cap=50, the oldest 10 are evicted. The retained
	// slice starts at seq=11 (inserted as the 11th block) through seq=60.
	if first := m.completedBlocks[0].Seq; first != 11 {
		t.Fatalf("completedBlocks[0].Seq = %d, want 11 (oldest 10 evicted)", first)
	}
	if last := m.completedBlocks[completedBlocksCap-1].Seq; last != 60 {
		t.Fatalf("completedBlocks[last].Seq = %d, want 60", last)
	}
}

// TestLookupCompletedBlock_NewestFirst pins the indexing convention: N=1
// returns the most recently appended block; N=len returns the oldest;
// N out of range returns ok=false so the dispatch path can render an
// error marker instead of panicking on a negative index.
func TestLookupCompletedBlock_NewestFirst(t *testing.T) {
	m := Model{}
	m.appendCompletedBlock(CompletedBlock{Seq: 1, Tool: "A", Output: "a"})
	m.appendCompletedBlock(CompletedBlock{Seq: 2, Tool: "B", Output: "b"})
	m.appendCompletedBlock(CompletedBlock{Seq: 3, Tool: "C", Output: "c"})

	// N=1 → most recent (C)
	block, ok := m.lookupCompletedBlock(1)
	if !ok || block.Tool != "C" {
		t.Fatalf("lookupCompletedBlock(1) = %+v, ok=%v; want Tool=C, ok=true", block, ok)
	}
	// N=3 → oldest (A)
	block, ok = m.lookupCompletedBlock(3)
	if !ok || block.Tool != "A" {
		t.Fatalf("lookupCompletedBlock(3) = %+v, ok=%v; want Tool=A, ok=true", block, ok)
	}
	// N=0 → out of range
	if _, ok := m.lookupCompletedBlock(0); ok {
		t.Fatalf("lookupCompletedBlock(0) should be ok=false")
	}
	// N=4 (past oldest) → out of range
	if _, ok := m.lookupCompletedBlock(4); ok {
		t.Fatalf("lookupCompletedBlock(4) should be ok=false")
	}
}
