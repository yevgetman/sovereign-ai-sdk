package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestParseDiffSplitsHunks(t *testing.T) {
	input := "@@ -1,3 +1,4 @@\n context line 1\n-old line\n+new line\n context line 2\n@@ -10,2 +10,3 @@\n ctx\n+added\n"
	got := ParseDiff(input)
	if len(got) != 2 {
		t.Fatalf("got %d hunks, want 2", len(got))
	}
	if got[0].Header != "@@ -1,3 +1,4 @@" {
		t.Errorf("hunk 0 header: %q", got[0].Header)
	}
	if len(got[0].Lines) != 4 {
		t.Errorf("hunk 0: got %d lines, want 4", len(got[0].Lines))
	}
	if got[1].Header != "@@ -10,2 +10,3 @@" {
		t.Errorf("hunk 1 header: %q", got[1].Header)
	}
}

func TestParseDiffMarksAddedRemovedContext(t *testing.T) {
	input := "@@ -1 +1 @@\n-removed\n+added\n context\n"
	hunks := ParseDiff(input)
	if len(hunks) != 1 {
		t.Fatalf("got %d hunks", len(hunks))
	}
	kinds := []DiffLineKind{}
	for _, l := range hunks[0].Lines {
		kinds = append(kinds, l.Kind)
	}
	want := []DiffLineKind{DiffRemoved, DiffAdded, DiffContext}
	if len(kinds) != len(want) {
		t.Fatalf("kinds: got %v want %v", kinds, want)
	}
	for i := range kinds {
		if kinds[i] != want[i] {
			t.Errorf("kind[%d]: got %v want %v", i, kinds[i], want[i])
		}
	}
}

func TestParseDiffEmptyInputReturnsEmpty(t *testing.T) {
	hunks := ParseDiff("")
	if len(hunks) != 0 {
		t.Errorf("got %d hunks for empty input, want 0", len(hunks))
	}
}

func TestParseDiffNoHunkHeaderReturnsEmpty(t *testing.T) {
	hunks := ParseDiff("just some plain text\nwithout any @@\n")
	if len(hunks) != 0 {
		t.Errorf("got %d hunks for non-diff input, want 0", len(hunks))
	}
}

func TestRenderHunksMarksActiveHunk(t *testing.T) {
	hunks := []Hunk{
		{Header: "@@ a", Lines: []HunkLine{{Kind: DiffContext, Text: "x"}}},
		{Header: "@@ b", Lines: []HunkLine{{Kind: DiffContext, Text: "y"}}},
	}
	out := RenderHunks(hunks, 1, theme.Dark(), 80)
	if !strings.Contains(out, "▶") {
		t.Errorf("active hunk should have ▶ marker; got: %q", out)
	}
}

func TestRenderHunksOutOfBoundsClampsToNoActive(t *testing.T) {
	hunks := []Hunk{{Header: "@@ a", Lines: nil}}
	out := RenderHunks(hunks, 99, theme.Dark(), 80)
	// Should not panic; no ▶ marker.
	if strings.Contains(out, "▶") {
		t.Errorf("out-of-bounds activeIdx should not mark any hunk; got: %q", out)
	}
}

func TestRenderHunksNegativeActiveIsHidden(t *testing.T) {
	hunks := []Hunk{{Header: "@@ a", Lines: nil}}
	out := RenderHunks(hunks, -1, theme.Dark(), 80)
	if strings.Contains(out, "▶") {
		t.Errorf("negative activeIdx should not mark any hunk; got: %q", out)
	}
}

func TestRenderHunksEmptyReturnsEmpty(t *testing.T) {
	out := RenderHunks(nil, 0, theme.Dark(), 80)
	if out != "" {
		t.Errorf("RenderHunks(nil): expected empty, got %q", out)
	}
}

func TestRenderHunksPreservesContent(t *testing.T) {
	hunks := []Hunk{{
		Header: "@@ -1 +1 @@",
		Lines: []HunkLine{
			{Kind: DiffRemoved, Text: "removed-line"},
			{Kind: DiffAdded, Text: "added-line"},
		},
	}}
	out := RenderHunks(hunks, 0, theme.Dark(), 80)
	if !strings.Contains(out, "removed-line") {
		t.Errorf("removed-line missing: %q", out)
	}
	if !strings.Contains(out, "added-line") {
		t.Errorf("added-line missing: %q", out)
	}
}
