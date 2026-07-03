package render

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

// ux-fixes 2026-05-22 (ux4.png): glamour v1.0.0's WithWordWrap
// produces orphan single-word lines at certain terminal widths
// (e.g., the input "...what the spec asked for..." at width 115
// rendered as "...the\nspec\nasked for..."). foldOrphanLines is the
// post-processor that folds those orphans back into the preceding
// content line. These tests pin the contract.

func TestFoldOrphanLines_MergesSingleWordIntoPrevious(t *testing.T) {
	in := "the quick brown fox\nspec\nasked for stuff\n"
	out := foldOrphanLines(in, 0)
	if strings.Contains(out, "\nspec\n") {
		t.Errorf("orphan 'spec' not folded: %q", out)
	}
	if !strings.Contains(out, "the quick brown fox spec") {
		t.Errorf("expected merge into previous line, got: %q", out)
	}
}

func TestFoldOrphanLines_LeavesListBulletsAlone(t *testing.T) {
	// A list item that happens to be a single word is structural —
	// don't fold it into the preceding line.
	in := "Intro paragraph.\n\n- alpha\n- beta\n"
	out := foldOrphanLines(in, 0)
	if !strings.Contains(out, "- alpha") {
		t.Errorf("list bullet got mangled: %q", out)
	}
	if strings.Contains(out, "Intro paragraph. - alpha") {
		t.Errorf("list bullet was incorrectly merged into prose: %q", out)
	}
}

func TestFoldOrphanLines_LeavesHeadingsAlone(t *testing.T) {
	in := "## Heading\nbody text\n"
	out := foldOrphanLines(in, 0)
	if !strings.Contains(out, "## Heading") {
		t.Errorf("heading mangled: %q", out)
	}
}

func TestFoldOrphanLines_LeavesBlockquoteAlone(t *testing.T) {
	in := "> quoted\nbody text\n"
	out := foldOrphanLines(in, 0)
	if !strings.Contains(out, "> quoted") {
		t.Errorf("blockquote mangled: %q", out)
	}
}

func TestFoldOrphanLines_DoesNotCrossBlankLine(t *testing.T) {
	// A blank line is a paragraph break — don't fold across.
	in := "first paragraph end.\n\norphan\n"
	out := foldOrphanLines(in, 0)
	if !strings.Contains(out, "first paragraph end.\n\norphan") {
		t.Errorf("fold crossed paragraph break: %q", out)
	}
}

func TestFoldOrphanLines_HandlesAnsiCodes(t *testing.T) {
	// Output from glamour has ANSI escape sequences (color, italic,
	// bold). The orphan detector strips ANSI for the content check,
	// but the merged line preserves the escape codes.
	in := "the \x1b[3mbeautiful\x1b[0m world is\nspec\nasked for it.\n"
	out := foldOrphanLines(in, 0)
	if strings.Contains(out, "\nspec\n") {
		t.Errorf("orphan with ANSI context not folded: %q", out)
	}
}

func TestFoldOrphanLines_PassesThroughCleanOutput(t *testing.T) {
	// No orphans → no changes. Idempotent.
	in := "First line of content.\nSecond line continues.\nThird line ends it.\n"
	out := foldOrphanLines(in, 0)
	if out != in {
		t.Errorf("clean output was modified: in=%q out=%q", in, out)
	}
}

func TestFoldOrphanLines_PreservesTrailingNewline(t *testing.T) {
	in := "alpha beta gamma\norphan\n"
	out := foldOrphanLines(in, 0)
	if !strings.HasSuffix(out, "\n") {
		t.Errorf("trailing newline dropped: %q", out)
	}
}

// --- FIX 5 (audit): width-aware fold ---

// TestFoldOrphanLines_DoesNotOverflowWidth proves an orphan is NOT folded
// into the previous line when doing so would push that line past the
// render width. Pre-fix the merge happened unconditionally, producing a
// line wider than the terminal (which the terminal then re-wrapped —
// visual overflow). With width threaded in and no following content line
// to fold into, the orphan is left in place rather than overflowing.
func TestFoldOrphanLines_DoesNotOverflowWidth(t *testing.T) {
	// prev line is 19 visible cols; orphan "tail" is 4 cols.
	// 19 + 1 + 4 = 24 > width 20 → must NOT fold into prev.
	prev := "aaaa bbbb cccc dddd" // 19 chars
	width := 20
	in := prev + "\ntail\n"
	out := foldOrphanLines(in, width)
	if strings.Contains(out, prev+" tail") {
		t.Errorf("orphan folded into prev despite overflow (width=%d): %q", width, out)
	}
	// And the result must not contain any line wider than width.
	for _, line := range strings.Split(out, "\n") {
		if lipgloss.Width(line) > width {
			t.Errorf("produced an over-width line (>%d): %q", width, line)
		}
	}
}

// TestFoldOrphanLines_FoldsWhenItFits proves the fold STILL happens for an
// orphan that fits within width — FIX 5 only suppresses the overflow case,
// it must not regress the normal fold.
func TestFoldOrphanLines_FoldsWhenItFits(t *testing.T) {
	prev := "short line" // 10 cols
	width := 60
	in := prev + "\ntail\n"
	out := foldOrphanLines(in, width)
	if !strings.Contains(out, "short line tail") {
		t.Errorf("orphan that fits should fold into prev (width=%d): %q", width, out)
	}
	if strings.Contains(out, "\ntail\n") {
		t.Errorf("orphan 'tail' should not survive when it fits: %q", out)
	}
}

// TestFoldOrphanLines_FoldsIntoNextWhenPrevOverflows proves the next-line
// escape hatch: when the previous-line merge would overflow but a short
// following content line exists, the orphan folds DOWN into it — removing
// the orphan without producing an over-width line.
func TestFoldOrphanLines_FoldsIntoNextWhenPrevOverflows(t *testing.T) {
	prev := "aaaa bbbb cccc dddd ee" // 22 cols — folding "and" up overflows width 24
	next := "short"
	width := 24
	in := prev + "\nand\n" + next + "\n"
	out := foldOrphanLines(in, width)
	// The orphan must be gone (no standalone "and" line).
	for _, line := range strings.Split(out, "\n") {
		plain := strings.TrimSpace(stripAnsiForFold(line))
		if plain == "and" {
			t.Errorf("orphan 'and' survived; expected fold into next line: %q", out)
		}
	}
	// It should have folded into the next line.
	if !strings.Contains(out, "and short") {
		t.Errorf("expected 'and' to fold into the next line; got %q", out)
	}
	// No line may exceed width.
	for _, line := range strings.Split(out, "\n") {
		if lipgloss.Width(line) > width {
			t.Errorf("produced an over-width line (>%d): %q", width, line)
		}
	}
}

// TestFoldOrphanLines_FoldDownPreservesNextIndent is the FIX (post-audit
// #45) regression: when an orphan folds DOWN into the next content line, the
// next line's ORIGINAL leading indentation must be preserved. Pre-fix the
// merge stored `orphanWord + " " + leftTrimmed(next)`, dropping the indent
// and shifting the continuation line's left margin within the paragraph.
func TestFoldOrphanLines_FoldDownPreservesNextIndent(t *testing.T) {
	prev := "aaaa bbbb cccc dddd ee" // 22 cols — folding "and" up overflows width 24
	const indent = "  "
	next := indent + "more text" // an indented, multi-word continuation line
	width := 24
	in := prev + "\nand\n" + next + "\n"
	out := foldOrphanLines(in, width)
	// The orphan must be gone…
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(stripAnsiForFold(line)) == "and" {
			t.Fatalf("orphan 'and' survived; expected fold into next line: %q", out)
		}
	}
	// …and the merged line must keep the next line's leading indentation.
	if !strings.Contains(out, indent+"and more text") {
		t.Errorf("fold-down dropped the next line's leading indent; want %q in %q", indent+"and more text", out)
	}
	// No line may exceed width (the measured string == the stored string).
	for _, line := range strings.Split(out, "\n") {
		if lipgloss.Width(line) > width {
			t.Errorf("produced an over-width line (>%d): %q", width, line)
		}
	}
}

// End-to-end regression guard: render the exact ux4.png input through
// the full Markdown() pipeline at the width where glamour orphaned
// "spec" and assert no single-word lines survive.
func TestMarkdown_NoOrphansAtUx4Width(t *testing.T) {
	text := `The DEVLOG story is *better* this way too: "I have a related project that does deterministic analysis with structured LLM output; for Betstamp I deliberately built a tool-using agent instead because that's what the spec asked for, and here's why that's the right call for the use case." That demonstrates judgment.`
	for _, w := range []int{100, 110, 115, 120, 125, 130, 135, 140, 150} {
		out := Markdown(text, theme.Dark(), w)
		lines := strings.Split(out, "\n")
		for i, line := range lines {
			plain := strings.TrimSpace(stripAnsiForFold(line))
			if plain == "" || isStructuralLine(plain) {
				continue
			}
			fields := strings.Fields(plain)
			if len(fields) == 1 {
				t.Errorf("width=%d line %d is an orphan single-word line: %q (full output: %q)", w, i, plain, out)
			}
		}
	}
}
