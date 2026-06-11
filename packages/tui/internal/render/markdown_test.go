package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestMarkdownTransformsInput(t *testing.T) {
	out := Markdown("**hello**", theme.Dark(), 80)
	if out == "" {
		t.Error("Markdown returned empty for non-empty input")
	}
	// glamour transforms the markdown — the rendered output should not
	// contain the raw markdown literal "**hello**".
	if strings.Contains(out, "**hello**") {
		t.Errorf("Markdown should transform; got raw input in: %q", out)
	}
	// But the word "hello" should still be present.
	if !strings.Contains(out, "hello") {
		t.Errorf("Markdown dropped content: %q", out)
	}
}

func TestMarkdownEmptyInputReturnsEmpty(t *testing.T) {
	out := Markdown("", theme.Dark(), 80)
	if out != "" {
		t.Errorf("Markdown(empty): expected empty, got %q", out)
	}
}

func TestMarkdownHeaderPreservesText(t *testing.T) {
	out := Markdown("# Title\n\nbody", theme.Dark(), 80)
	if !strings.Contains(out, "Title") {
		t.Errorf("Markdown header: missing Title text: %q", out)
	}
	if !strings.Contains(out, "body") {
		t.Errorf("Markdown header: missing body text: %q", out)
	}
}

func TestMarkdownLightThemeRenders(t *testing.T) {
	out := Markdown("# Light", theme.Light(), 80)
	if !strings.Contains(out, "Light") {
		t.Errorf("Markdown(light): missing Light text: %q", out)
	}
}

// TestMarkdownHeadingsAreThemeIndependent guards the ux-fixes choice:
// H1–H6 colors are pinned to a fixed light-blue hex (sky-100 #e0f2fe)
// rather than derived from theme.Primary, so headings read as the
// same shade across every theme. Dark.Primary (#89b4fa) and
// Sovereign.Primary (#58a6ff) differ; if headings still tracked
// Primary, this test would fail. A simple "## Header\n\nbody" input
// touches only the Heading/H2 + Paragraph/Text glamour fields — all
// other theme-derived fields (dim, success, error, code) are not
// exercised — so the rendered output must be byte-identical across
// themes when headings use a fixed hex.
func TestMarkdownHeadingsAreThemeIndependent(t *testing.T) {
	src := "## Header\n\nbody"
	outDark := Markdown(src, theme.Dark(), 80)
	outSov := Markdown(src, theme.Sovereign(), 80)
	if outDark != outSov {
		t.Errorf("markdown headings should be theme-independent (fixed light-blue hex); Dark and Sovereign produced different output:\n--- Dark:\n%q\n--- Sovereign:\n%q", outDark, outSov)
	}
}

// M11.12 — wrapFileRefs auto-wraps file-path-shaped tokens in
// backticks so the inline Code style applies. Tests pin the regex
// boundaries and the backtick-respecting traversal.

func TestWrapFileRefs_BareFilename(t *testing.T) {
	out := wrapFileRefs("see README.md for details")
	if !strings.Contains(out, "`README.md`") {
		t.Errorf("expected README.md wrapped in backticks, got %q", out)
	}
}

func TestWrapFileRefs_AbsolutePath(t *testing.T) {
	out := wrapFileRefs("the file at /Users/julie/code/repo.go was changed")
	if !strings.Contains(out, "`/Users/julie/code/repo.go`") {
		t.Errorf("expected absolute path wrapped, got %q", out)
	}
}

func TestWrapFileRefs_TildePath(t *testing.T) {
	out := wrapFileRefs("see ~/code/foo/bar.ts for the impl")
	if !strings.Contains(out, "`~/code/foo/bar.ts`") {
		t.Errorf("expected ~/path wrapped, got %q", out)
	}
}

func TestWrapFileRefs_RelativePath(t *testing.T) {
	out := wrapFileRefs("run ./script.sh now")
	if !strings.Contains(out, "`./script.sh`") {
		t.Errorf("expected ./script.sh wrapped, got %q", out)
	}
}

func TestWrapFileRefs_PreservesExistingBackticks(t *testing.T) {
	in := "the file `already.md` should stay wrapped once"
	out := wrapFileRefs(in)
	if strings.Contains(out, "``already.md``") {
		t.Errorf("double-wrapped existing backticks: %q", out)
	}
	if !strings.Contains(out, "`already.md`") {
		t.Errorf("expected backtick span preserved, got %q", out)
	}
}

func TestWrapFileRefs_LeavesFencedCodeUntouched(t *testing.T) {
	in := "Here's some code:\n```go\nfile := \"main.go\"\n```\nand outside.go is a file"
	out := wrapFileRefs(in)
	codeBlock := strings.SplitN(out, "```", 3)
	if len(codeBlock) < 3 {
		t.Fatalf("fenced block split unexpectedly: %q", out)
	}
	inside := codeBlock[1]
	if strings.Contains(inside, "`main.go`") {
		t.Errorf("fenced code block was modified: %q", inside)
	}
	if !strings.Contains(codeBlock[2], "`outside.go`") {
		t.Errorf("outside-fence file ref not wrapped: %q", codeBlock[2])
	}
}

func TestWrapFileRefs_DoesNotMatchVersionNumbers(t *testing.T) {
	out := wrapFileRefs("upgraded to version 1.0 today")
	if strings.Contains(out, "`") {
		t.Errorf("version 1.0 was incorrectly wrapped: %q", out)
	}
}

func TestWrapFileRefs_MultipleRefsInList(t *testing.T) {
	in := "Files:\n- foo.png\n- bar.md\n- baz.json"
	out := wrapFileRefs(in)
	for _, want := range []string{"`foo.png`", "`bar.md`", "`baz.json`"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %s in output, got %q", want, out)
		}
	}
}

func TestWrapFileRefs_EmptyString(t *testing.T) {
	if out := wrapFileRefs(""); out != "" {
		t.Errorf("empty input should return empty, got %q", out)
	}
}

func TestWrapFileRefs_NoFileRefsLeavesTextAlone(t *testing.T) {
	in := "This is a regular sentence with no file references."
	out := wrapFileRefs(in)
	if out != in {
		t.Errorf("plain prose was modified:\n  in:  %q\n  out: %q", in, out)
	}
}

// M11.13 — multi-word filename handling. Bullet lists are the
// common shape; the WHOLE bullet content gets wrapped when it ends
// in a known extension, including internal spaces.

func TestWrapFileRefs_BulletWithSpacesInFilename(t *testing.T) {
	in := "- Babyboard logo circulat.png"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`Babyboard logo circulat.png`") {
		t.Errorf("expected full multi-word filename wrapped, got %q", out)
	}
}

func TestWrapFileRefs_BulletWithUnderscoresAndDashes(t *testing.T) {
	in := "- ChatGPT Image May 2, 2026, 04_54_57 PM.png"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`ChatGPT Image May 2, 2026, 04_54_57 PM.png`") {
		t.Errorf("expected full filename with punctuation wrapped, got %q", out)
	}
}

func TestWrapFileRefs_BulletWithStarPrefix(t *testing.T) {
	in := "* Screenshot 2026-05-18 at 5.15.30 AM.png"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`Screenshot 2026-05-18 at 5.15.30 AM.png`") {
		t.Errorf("expected * bullet content wrapped, got %q", out)
	}
}

func TestWrapFileRefs_BulletWithoutExtensionLeftAlone(t *testing.T) {
	in := "- this is just a plain bullet"
	out := wrapFileRefs(in)
	if strings.Contains(out, "`") {
		t.Errorf("non-file bullet should NOT be wrapped, got %q", out)
	}
}

func TestWrapFileRefs_IndentedBullet(t *testing.T) {
	in := "  - nested file.md"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`nested file.md`") {
		t.Errorf("expected indented bullet content wrapped, got %q", out)
	}
}

func TestWrapFileRefs_MultipleBulletsInList(t *testing.T) {
	in := "- one file.png\n- another doc.md\n- plain bullet\n- third file.json"
	out := wrapFileRefs(in)
	for _, want := range []string{"`one file.png`", "`another doc.md`", "`third file.json`"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %s in output, got %q", want, out)
		}
	}
	// Plain bullet should NOT get wrapped.
	if strings.Contains(out, "`plain bullet`") {
		t.Errorf("non-file bullet incorrectly wrapped: %q", out)
	}
}

// 2026-06-11 — the extension allow-list was missing common document,
// media, and archive types (pdf, mov, zip, …), so filenames a user
// sees in a "files on my Desktop" listing went unhighlighted while
// their .png/.md/.txt neighbors lit up (us1.png feedback). These pin
// the now-recognized categories. All are bullets, the common shape.

func TestWrapFileRefs_BulletWithPdfExtension(t *testing.T) {
	in := "- Yevgeny_Getman_Resume.pdf"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`Yevgeny_Getman_Resume.pdf`") {
		t.Errorf("expected .pdf filename wrapped, got %q", out)
	}
}

func TestWrapFileRefs_BulletWithEmDashAndPdf(t *testing.T) {
	// The exact us1.png case: an em-dash (U+2014) and spaces in a .pdf
	// bullet. The bullet pass wraps the whole content as a unit; the
	// only thing that was missing was .pdf in the extension list.
	in := "- Vulcan — Deployed Agent Orchestrators.pdf"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`Vulcan — Deployed Agent Orchestrators.pdf`") {
		t.Errorf("expected multi-word em-dash .pdf filename wrapped, got %q", out)
	}
}

func TestWrapFileRefs_BulletWithMovExtension(t *testing.T) {
	in := "- Screen Recording 2026-06-10 at 3.29.26 PM.mov"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`Screen Recording 2026-06-10 at 3.29.26 PM.mov`") {
		t.Errorf("expected .mov screen-recording filename wrapped, got %q", out)
	}
}

func TestWrapFileRefs_BulletWithZipExtension(t *testing.T) {
	in := "- MarkdownViewer.zip"
	out := wrapFileRefs(in)
	if !strings.Contains(out, "`MarkdownViewer.zip`") {
		t.Errorf("expected .zip filename wrapped, got %q", out)
	}
}

func TestWrapFileRefs_ProseMediaAndDocExtensions(t *testing.T) {
	// Space-free media/doc/archive tokens in prose must also light up
	// via the token-level pass, not just bullets.
	out := wrapFileRefs("saved report.pdf, clip.mov, and bundle.zip today")
	for _, want := range []string{"`report.pdf`", "`clip.mov`", "`bundle.zip`"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %s wrapped in prose, got %q", want, out)
		}
	}
}

// ux-fixes round 2 — wrapFileRefs gained a table-cell awareness pass
// so multi-word filenames sitting in a markdown table row pick up the
// inline-code styling. The token-level fileRefPattern is constrained
// to space-free tokens; bullet path handles "- foo bar.png" but not
// `| 1.1M | Babyboard logo circulat.png |`.

func TestWrapFileRefs_TableCellMultiWordFilenameLeftAlone(t *testing.T) {
	// ux-fixes round 3: table cells are no longer backtick-wrapped at
	// all. Wrapping inline-code styling inside a table cell triggered
	// ANSI-reset interleaving with lipgloss's cell-width-aware Render,
	// which leaked reset sequences across cell boundaries and produced
	// continuation rows that visually escaped their column (ux3.png /
	// ux4.png). The table renderer keeps cell content clean when no
	// per-cell styling is applied; we accept losing the inline-code
	// styling on multi-word filenames inside tables as the cost.
	in := "| 1.1M | Babyboard logo circulat.png |"
	out := wrapFileRefs(in)
	if strings.Contains(out, "`Babyboard logo circulat.png`") {
		t.Errorf("table cell content should be left un-backticked post round 3, got %q", out)
	}
	// Non-filename cells (size, separator) should also not be wrapped.
	if strings.Contains(out, "`1.1M`") {
		t.Errorf("size cell incorrectly wrapped: %q", out)
	}
}

func TestWrapFileRefs_TableCellWithFilenameWithCommasAndUnderscoresLeftAlone(t *testing.T) {
	// Same reasoning as TestWrapFileRefs_TableCellMultiWordFilenameLeftAlone
	// — ux-fixes round 3 disabled backtick-wrap on table rows entirely.
	in := "| 495K | ChatGPT Image May 2, 2026, 04_54_57 PM.png |"
	out := wrapFileRefs(in)
	if strings.Contains(out, "`ChatGPT Image May 2, 2026, 04_54_57 PM.png`") {
		t.Errorf("table cell should be left un-backticked post round 3, got %q", out)
	}
}

func TestWrapFileRefs_TableHeaderRowLeftAlone(t *testing.T) {
	in := "| Size | File Name |"
	out := wrapFileRefs(in)
	// Neither "Size" nor "File Name" ends in a recognized extension —
	// the table pass should leave them alone.
	if strings.Contains(out, "`Size`") || strings.Contains(out, "`File Name`") {
		t.Errorf("header row cells incorrectly wrapped: %q", out)
	}
}

func TestWrapFileRefs_TableSeparatorRowLeftAlone(t *testing.T) {
	in := "|------|-----------|"
	out := wrapFileRefs(in)
	if strings.Contains(out, "`") {
		t.Errorf("separator row should not be modified, got %q", out)
	}
}

func TestWrapFileRefs_TableCellSinglePathRefLeftAlone(t *testing.T) {
	// ux-fixes round 3: table rows are entirely skipped by the
	// backtick-wrapping pass to avoid ANSI-reset interleaving inside
	// cells. Single-token paths in table cells were previously wrapped
	// via the token-level pass; that path now early-exits on table
	// rows. The trade-off: file paths in tables lose inline-code
	// styling but the table itself renders cleanly (ux3.png / ux4.png).
	in := "| status | /path/to/foo.go |"
	out := wrapFileRefs(in)
	if strings.Contains(out, "`/path/to/foo.go`") {
		t.Errorf("table cell should be left un-backticked post round 3, got %q", out)
	}
}

func TestWrapFileRefs_TableCellAlreadyBacktickWrappedLeftAlone(t *testing.T) {
	// If a model helpfully pre-wraps the filename in backticks, the
	// table pass should not double-wrap. The outer backticks split in
	// wrapFileRefsOutsideBackticks already handles this for the most
	// part; the table pass also guards on prefix/suffix to be safe.
	in := "| 1.1M | `already wrapped.png` |"
	out := wrapFileRefs(in)
	if strings.Contains(out, "``already wrapped.png``") {
		t.Errorf("already-wrapped filename was double-wrapped: %q", out)
	}
}

func TestWrapFileRefs_MultipleRowsOfTableAllCellsLeftAlone(t *testing.T) {
	// ux-fixes round 3: every cell across the table stays un-backticked.
	// Prose lines OUTSIDE the table still pick up file-ref styling via
	// the token pass, but table content is preserved verbatim so
	// lipgloss's cell-width Render doesn't have to manage ANSI escape
	// boundaries.
	in := strings.Join([]string{
		"| Size | File Name |",
		"|------|-----------|",
		"| 1.1M | Babyboard logo circulat.png |",
		"| 942K | Babyboard logo.png |",
		"| 320K | uxc1.png |",
	}, "\n")
	out := wrapFileRefs(in)
	for _, banned := range []string{
		"`Babyboard logo circulat.png`",
		"`Babyboard logo.png`",
		"`uxc1.png`",
	} {
		if strings.Contains(out, banned) {
			t.Errorf("table cell incorrectly backticked: %s\nfull output:\n%s", banned, out)
		}
	}
	// Negative: input lines are preserved verbatim through the wrap
	// pass (apart from the line-by-line split/join which adds no
	// characters).
	if out != in {
		t.Errorf("expected table rows preserved verbatim; got:\n%s\nwant:\n%s", out, in)
	}
}

func TestMarkdown_LongBulletWrapsWithHangIndent(t *testing.T) {
	// ux-fixes round 3: long bullets must wrap with their continuation
	// lines indented under the text-after-bullet column. Pre-round-3
	// the List.StyleBlock omitted Indent, so glamour's BlockStack.Indent
	// resolved to 0 and continuation rows flush-left'd against the
	// document margin (ux3.png / ux4.png ragged-bullet feedback).
	//
	// Verifying the exact wrap column is brittle (glamour wraps at
	// word boundaries and the precise width depends on margin + bullet
	// glyph). Instead, assert the structural invariant: a long bullet
	// renders across at least two non-empty lines AND the second line
	// is indented (starts with whitespace) — both of which fail under
	// the pre-round-3 behavior.
	in := "- " + strings.Repeat("alpha beta gamma ", 10)
	out := Markdown(in, theme.Dark(), 40)
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	var contentLines []string
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			contentLines = append(contentLines, line)
		}
	}
	if len(contentLines) < 2 {
		t.Fatalf("expected long bullet to wrap to >= 2 lines, got %d:\n%s", len(contentLines), out)
	}
	// The second content line MUST start with at least 1 space — the
	// hang-indent under the bullet's text column.
	second := contentLines[1]
	if !strings.HasPrefix(second, " ") {
		t.Errorf("expected continuation line to start with leading whitespace (hang-indent); got %q\nfull output:\n%s", second, out)
	}
}
