package render

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestPlainPreservesContent(t *testing.T) {
	out := Plain("hello", theme.Dark(), 20)
	if !strings.Contains(out, "hello") {
		t.Errorf("Plain dropped content: %q", out)
	}
}

func TestPlainEmptyInputReturnsEmpty(t *testing.T) {
	out := Plain("", theme.Dark(), 80)
	if strings.TrimSpace(out) != "" {
		t.Errorf("Plain(empty): expected empty/whitespace, got %q", out)
	}
}

func TestPlainZeroWidthReturnsInput(t *testing.T) {
	in := "hello"
	out := Plain(in, theme.Dark(), 0)
	if out != in {
		t.Errorf("Plain(width=0): want %q got %q", in, out)
	}
}
