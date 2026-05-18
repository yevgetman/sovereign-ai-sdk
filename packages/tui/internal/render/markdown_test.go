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
