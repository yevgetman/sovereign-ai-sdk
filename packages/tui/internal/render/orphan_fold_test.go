package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// ux-fixes 2026-05-22 (ux4.png): glamour v1.0.0's WithWordWrap
// produces orphan single-word lines at certain terminal widths
// (e.g., the input "...what the spec asked for..." at width 115
// rendered as "...the\nspec\nasked for..."). foldOrphanLines is the
// post-processor that folds those orphans back into the preceding
// content line. These tests pin the contract.

func TestFoldOrphanLines_MergesSingleWordIntoPrevious(t *testing.T) {
	in := "the quick brown fox\nspec\nasked for stuff\n"
	out := foldOrphanLines(in)
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
	out := foldOrphanLines(in)
	if !strings.Contains(out, "- alpha") {
		t.Errorf("list bullet got mangled: %q", out)
	}
	if strings.Contains(out, "Intro paragraph. - alpha") {
		t.Errorf("list bullet was incorrectly merged into prose: %q", out)
	}
}

func TestFoldOrphanLines_LeavesHeadingsAlone(t *testing.T) {
	in := "## Heading\nbody text\n"
	out := foldOrphanLines(in)
	if !strings.Contains(out, "## Heading") {
		t.Errorf("heading mangled: %q", out)
	}
}

func TestFoldOrphanLines_LeavesBlockquoteAlone(t *testing.T) {
	in := "> quoted\nbody text\n"
	out := foldOrphanLines(in)
	if !strings.Contains(out, "> quoted") {
		t.Errorf("blockquote mangled: %q", out)
	}
}

func TestFoldOrphanLines_DoesNotCrossBlankLine(t *testing.T) {
	// A blank line is a paragraph break — don't fold across.
	in := "first paragraph end.\n\norphan\n"
	out := foldOrphanLines(in)
	if !strings.Contains(out, "first paragraph end.\n\norphan") {
		t.Errorf("fold crossed paragraph break: %q", out)
	}
}

func TestFoldOrphanLines_HandlesAnsiCodes(t *testing.T) {
	// Output from glamour has ANSI escape sequences (color, italic,
	// bold). The orphan detector strips ANSI for the content check,
	// but the merged line preserves the escape codes.
	in := "the \x1b[3mbeautiful\x1b[0m world is\nspec\nasked for it.\n"
	out := foldOrphanLines(in)
	if strings.Contains(out, "\nspec\n") {
		t.Errorf("orphan with ANSI context not folded: %q", out)
	}
}

func TestFoldOrphanLines_PassesThroughCleanOutput(t *testing.T) {
	// No orphans → no changes. Idempotent.
	in := "First line of content.\nSecond line continues.\nThird line ends it.\n"
	out := foldOrphanLines(in)
	if out != in {
		t.Errorf("clean output was modified: in=%q out=%q", in, out)
	}
}

func TestFoldOrphanLines_PreservesTrailingNewline(t *testing.T) {
	in := "alpha beta gamma\norphan\n"
	out := foldOrphanLines(in)
	if !strings.HasSuffix(out, "\n") {
		t.Errorf("trailing newline dropped: %q", out)
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
