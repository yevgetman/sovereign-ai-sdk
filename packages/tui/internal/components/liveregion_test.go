// LiveRegion unit tests — pin the contract introduced by the
// ux-fixes-round-5 inline-mode refactor. The transcript is no longer
// a scrollable viewport; LiveRegion owns the bottom-of-screen live
// region that holds the in-flight streaming card + spinner + running-
// command indicator. Anything destined for scrollback flows through
// the model's pendingPrintln queue (tested elsewhere).

package components

import (
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func TestLiveRegion_EmptyByDefault(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	if got := l.View(); got != "" {
		t.Errorf("fresh LiveRegion should render empty; got %q", got)
	}
	if l.HasStreaming() {
		t.Error("fresh LiveRegion should not report HasStreaming")
	}
}

func TestLiveRegion_StreamingAccumulates(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("Hello ")
	l.AppendAssistantDelta("world.")
	view := l.View()
	if !strings.Contains(view, "Hello world.") {
		t.Errorf("streaming view should accumulate deltas; got %q", view)
	}
	if !l.HasStreaming() {
		t.Error("HasStreaming should be true with content")
	}
}

func TestLiveRegion_EndAssistantCard_ReturnsRenderedAndClears(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("**bold** text")
	rendered, ok := l.EndAssistantCard()
	if !ok {
		t.Fatal("EndAssistantCard should return ok=true when content was streaming")
	}
	// Glamour renders **bold** → ANSI; the literal markdown should be
	// consumed but the word "bold" preserved.
	if !strings.Contains(rendered, "bold") {
		t.Errorf("rendered card should preserve content; got %q", rendered)
	}
	if strings.Contains(rendered, "**bold**") {
		t.Errorf("rendered card should consume raw markdown; got %q", rendered)
	}
	if l.HasStreaming() {
		t.Error("LiveRegion should be cleared after EndAssistantCard")
	}
	if l.View() != "" {
		t.Errorf("View should be empty after EndAssistantCard; got %q", l.View())
	}
}

func TestLiveRegion_EndAssistantCard_NoOpWhenEmpty(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	_, ok := l.EndAssistantCard()
	if ok {
		t.Error("EndAssistantCard should return ok=false on empty stream")
	}
}

func TestLiveRegion_SpinnerInViewAndCleared(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetSpinner("  ⢀  Thinking...")
	if !strings.Contains(l.View(), "Thinking...") {
		t.Errorf("spinner should appear in View; got %q", l.View())
	}
	l.ClearSpinner()
	if strings.Contains(l.View(), "Thinking...") {
		t.Errorf("spinner should clear via ClearSpinner; got %q", l.View())
	}
}

func TestLiveRegion_RunningCommandIndicator(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetRunningCommand("…running /cost")
	if !strings.Contains(l.View(), "/cost") {
		t.Errorf("running command should appear in View; got %q", l.View())
	}
	l.SetRunningCommand("")
	if strings.Contains(l.View(), "/cost") {
		t.Errorf("running command should clear when set to empty; got %q", l.View())
	}
}

func TestLiveRegion_StreamingAboveSpinner(t *testing.T) {
	// View() composes streaming card BEFORE spinner so the user sees
	// the partial response above the "still thinking" indicator. This
	// matches the pre-refactor visual order.
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("partial response")
	l.SetSpinner("⢀ thinking")
	view := l.View()
	streamIdx := strings.Index(view, "partial response")
	spinnerIdx := strings.Index(view, "thinking")
	if streamIdx == -1 || spinnerIdx == -1 {
		t.Fatalf("both stream and spinner should appear: %q", view)
	}
	if streamIdx > spinnerIdx {
		t.Errorf("streaming card should render ABOVE spinner; stream@%d, spinner@%d", streamIdx, spinnerIdx)
	}
}

func TestLiveRegion_SetThemeAffectsFutureRender(t *testing.T) {
	// Swap to light theme mid-stream; the next View should reflect the
	// new theme's accent. We don't pin ANSI bytes (lipgloss strips in
	// test contexts) — instead, assert the call doesn't crash and the
	// content survives.
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("hello")
	l.SetTheme(theme.Light())
	if !strings.Contains(l.View(), "hello") {
		t.Errorf("content should survive SetTheme; got %q", l.View())
	}
}

// --- FIX 6 (audit): render memoization across spinner ticks ---

// TestLiveRegion_RenderCacheWarmAfterDelta proves the markdown render is
// memoized once a delta lands: the cache key (length, hash, width, theme)
// matches the current buffer so a subsequent unchanged View() reuses it.
func TestLiveRegion_RenderCacheWarmAfterDelta(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("**bold** body text")
	if !l.mdCacheOK {
		t.Fatal("expected render cache to be warm after a delta")
	}
	body := l.stream.String()
	wantLen, wantHash, wantName := l.streamRenderKey(body)
	if l.mdCacheLen != wantLen || l.mdCacheHash != wantHash || l.mdCacheW != 80 || l.mdCacheName != wantName {
		t.Errorf("cache key mismatch after delta: len=%d/%d hash=%d/%d w=%d/80 name=%q/%q",
			l.mdCacheLen, wantLen, l.mdCacheHash, wantHash, l.mdCacheW, l.mdCacheName, wantName)
	}
}

// TestLiveRegion_SpinnerTickReusesCachedRender is the central FIX 6
// assertion: a spinner-only update (SetSpinner — no buffer/width/theme
// change) must NOT invalidate the render cache, and View() must return
// the cached string verbatim. We prove the cache is consulted by mutating
// the stored cache string to a sentinel and confirming View() echoes it
// (it would NOT if View re-ran the markdown pipeline).
func TestLiveRegion_SpinnerTickReusesCachedRender(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("streaming partial")
	if !l.mdCacheOK {
		t.Fatal("expected warm cache after delta")
	}
	// Poison the cached render with a sentinel that the real markdown
	// pipeline would never produce. A cache HIT serves this verbatim;
	// a re-render would replace it with the actual rendered text.
	const sentinel = "SENTINEL-CACHED-RENDER-XYZ"
	l.mdCache = sentinel
	// A spinner-only tick: buffer, width, theme all unchanged.
	l.SetSpinner("⢀ thinking")
	view := l.View()
	if !strings.Contains(view, sentinel) {
		t.Errorf("spinner-only tick should reuse cached render (sentinel expected); got %q", view)
	}
	if strings.Contains(view, "streaming partial") {
		t.Errorf("View re-rendered the buffer instead of using the cache; got %q", view)
	}
}

// TestLiveRegion_DeltaInvalidatesCache proves a real delta forces a
// recompute (the cache must NOT serve a stale render after the buffer
// changes). After poisoning the cache, a new delta should refresh it so
// View() shows the actual content, not the sentinel.
func TestLiveRegion_DeltaInvalidatesCache(t *testing.T) {
	l := NewLiveRegion(theme.Dark())
	l.SetWidth(80)
	l.AppendAssistantDelta("first")
	l.mdCache = "STALE-SENTINEL"
	// A genuine new delta changes the buffer → cache refreshes.
	l.AppendAssistantDelta(" second")
	view := l.View()
	if strings.Contains(view, "STALE-SENTINEL") {
		t.Errorf("stale cache served after a real delta; got %q", view)
	}
	if !strings.Contains(view, "first second") {
		t.Errorf("expected refreshed render with new content; got %q", view)
	}
}
