package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// ux-fixes 2026-05-22 (ux1.png-v2): glamour v1.0.0 emits a markdown
// table's header row and separator row on the SAME line, breaking
// every table render. splitSmashedTableHeader is the post-processor
// that splits the smashed line into the two-line form glamour should
// have produced.

func TestSplitSmashedTableHeader_Basic(t *testing.T) {
	in := " Tool                        │ What it did ─────────────────────────────┼────────────────────────────"
	if !looksLikeSmashedTableHeader(in) {
		t.Fatal("should detect smashed line")
	}
	header, sep, ok := splitSmashedLine(in)
	if !ok {
		t.Fatal("split should succeed")
	}
	if !strings.Contains(header, "Tool") || !strings.Contains(header, "What it did") {
		t.Errorf("header missing content: %q", header)
	}
	if strings.ContainsRune(header, '─') || strings.ContainsRune(header, '┼') {
		t.Errorf("header still contains separator chars: %q", header)
	}
	if !strings.ContainsRune(sep, '┼') {
		t.Errorf("separator missing center cross: %q", sep)
	}
	// Verify ┼ aligns with the original │ position in the header.
	headerRunes := []rune(header)
	sepRunes := []rune(sep)
	for i, r := range headerRunes {
		if r == '│' && i < len(sepRunes) && sepRunes[i] != '┼' {
			t.Errorf("col-separator alignment mismatch at %d: header=│, sep=%q", i, sepRunes[i])
		}
	}
}

func TestSplitSmashedTableHeader_PassesThroughCleanLines(t *testing.T) {
	in := strings.Join([]string{
		" alpha       │ beta",
		"─────────────┼──────",
		" data        │ row",
	}, "\n")
	out := splitSmashedTableHeader(in)
	if out != in {
		t.Errorf("clean table mangled: in=%q out=%q", in, out)
	}
}

func TestSplitSmashedTableHeader_LeavesNonTableLinesAlone(t *testing.T) {
	in := "Just some prose text here.\nNothing special.\n"
	out := splitSmashedTableHeader(in)
	if out != in {
		t.Errorf("non-table text was modified: %q → %q", in, out)
	}
}

func TestSplitSmashedTableHeader_FoldOrphanLinesLeavesSeparatorAlone(t *testing.T) {
	// Regression guard: foldOrphanLines should NOT merge the
	// reconstructed separator row into the header (the separator is
	// box-drawing only — isStructuralLine recognises that and skips
	// the fold). Without this guard, the orphan fold would undo the
	// table split.
	in := strings.Join([]string{
		" alpha       │ beta",
		"─────────────┼──────",
		" data        │ row",
	}, "\n")
	out := foldOrphanLines(in)
	if !strings.Contains(out, "─────────────┼──────") {
		t.Errorf("separator row was folded away: %q", out)
	}
}

// End-to-end regression guard: render a markdown table through the
// full Markdown() pipeline and verify the output contains a separator
// row on its own line (no `│` + `┼` on the same line anywhere).
func TestMarkdown_TableRendersWithSeparatorOnOwnLine(t *testing.T) {
	text := "| Tool | What it did |\n|------|-------------|\n| bash | ran a thing |\n"
	for _, w := range []int{60, 80, 100, 120} {
		out := Markdown(text, theme.Dark(), w)
		for _, line := range strings.Split(out, "\n") {
			if strings.ContainsRune(line, '│') && strings.ContainsRune(line, '┼') {
				t.Errorf("width=%d still has smashed line: %q\n(full output: %s)", w, line, out)
			}
		}
	}
}

func TestIsBoxDrawingOnly(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"─────────┼────", true},
		{"────────────", true},
		{"  ────  ", true},
		{"", false},
		{"   ", false}, // whitespace only — not box drawing
		{"prose", false},
		{"── prose ──", false},
		{"│", true},
	}
	for _, tc := range cases {
		got := isBoxDrawingOnly(tc.in)
		if got != tc.want {
			t.Errorf("isBoxDrawingOnly(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
