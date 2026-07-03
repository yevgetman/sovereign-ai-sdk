// Notification component tests — pin the empty-message contract,
// the BootNotices conditions, and the visual border rendering. M11.3.

package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestNotification_EmptyMessageReturnsEmpty(t *testing.T) {
	out := Notification("", theme.Dark(), 80)
	if out != "" {
		t.Errorf("empty message should return empty string, got %q", out)
	}
}

func TestNotification_RendersBorderedBox(t *testing.T) {
	out := Notification("hello", theme.Dark(), 80)
	// Rounded border characters; the content must contain at least one
	// border corner glyph (lipgloss uses ╭ ╰ for rounded).
	if !strings.Contains(out, "╭") || !strings.Contains(out, "╰") {
		t.Errorf("notification missing rounded border corners; got:\n%s", out)
	}
	if !strings.Contains(out, "hello") {
		t.Errorf("notification missing message text; got:\n%s", out)
	}
}

func TestNotification_NoCrashOnZeroWidth(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Notification panicked on width=0: %v", r)
		}
	}()
	_ = Notification("x", theme.Dark(), 0)
}

func TestBootNotices_HomeDirectoryAdvisory(t *testing.T) {
	notices := BootNotices("/home/user", "/home/user", "/some/bundle")
	if len(notices) != 1 {
		t.Fatalf("expected 1 notice (home dir), got %d: %v", len(notices), notices)
	}
	if !strings.Contains(notices[0], "home directory") {
		t.Errorf("expected home-directory advisory, got %q", notices[0])
	}
}

func TestBootNotices_NoBundleAdvisory(t *testing.T) {
	notices := BootNotices("/some/project", "/home/user", "")
	if len(notices) != 1 {
		t.Fatalf("expected 1 notice (no bundle), got %d: %v", len(notices), notices)
	}
	if !strings.Contains(notices[0], "No bundle") {
		t.Errorf("expected no-bundle advisory, got %q", notices[0])
	}
}

func TestBootNotices_BothAdvisoriesWhenHomeAndNoBundle(t *testing.T) {
	notices := BootNotices("/home/user", "/home/user", "")
	if len(notices) != 2 {
		t.Errorf("expected 2 notices, got %d: %v", len(notices), notices)
	}
}

func TestBootNotices_NoneWhenProjectWithBundle(t *testing.T) {
	notices := BootNotices("/some/project", "/home/user", "/some/bundle")
	if len(notices) != 0 {
		t.Errorf("expected 0 notices, got %d: %v", len(notices), notices)
	}
}

func TestJoinNotices_EmptyReturnsEmpty(t *testing.T) {
	out := JoinNotices(nil, theme.Dark(), 80)
	if out != "" {
		t.Errorf("empty notices should return empty string, got %q", out)
	}
}

func TestJoinNotices_RendersAll(t *testing.T) {
	notices := []string{"first notice", "second notice"}
	out := JoinNotices(notices, theme.Dark(), 80)
	if !strings.Contains(out, "first notice") {
		t.Errorf("missing first notice; got:\n%s", out)
	}
	if !strings.Contains(out, "second notice") {
		t.Errorf("missing second notice; got:\n%s", out)
	}
}

func TestHintLine_EmptyReturnsEmpty(t *testing.T) {
	out := HintLine("", theme.Dark())
	if out != "" {
		t.Errorf("empty hint should return empty string, got %q", out)
	}
}

func TestHintLine_RendersText(t *testing.T) {
	out := HintLine("? for shortcuts", theme.Dark())
	if !strings.Contains(out, "? for shortcuts") {
		t.Errorf("hint missing text; got:\n%s", out)
	}
}
