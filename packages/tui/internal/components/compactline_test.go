package components

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

func mkJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return json.RawMessage(b)
}

// stripANSI removes ANSI escape sequences so tests can assert on plain
// text without depending on the specific color codes lipgloss emits.
// Minimal: handles the CSI sequences lipgloss generates.
func stripANSI(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if i+1 < len(s) && s[i] == 0x1b && s[i+1] == '[' {
			// CSI: ESC [ ... letter
			j := i + 2
			for j < len(s) {
				c := s[j]
				if (c >= '@' && c <= '~') {
					j++
					break
				}
				j++
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func TestFormatCompactToolLine_FileRead(t *testing.T) {
	out := FormatCompactToolLine(
		"FileRead",
		mkJSON(t, map[string]any{"path": "/Users/julie/code/foo.go"}),
		mkJSON(t, map[string]any{"status": "success", "summary": "ok · 42 lines"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Read /Users/julie/code/foo.go") {
		t.Errorf("expected 'Read /Users/julie/code/foo.go', got: %q", plain)
	}
	if !strings.Contains(plain, CompactLineChevron) {
		t.Errorf("expected chevron in line, got: %q", plain)
	}
}

func TestFormatCompactToolLine_FileWrite(t *testing.T) {
	out := FormatCompactToolLine(
		"FileWrite",
		mkJSON(t, map[string]any{"path": "/tmp/new.md"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Wrote /tmp/new.md") {
		t.Errorf("expected 'Wrote /tmp/new.md', got: %q", plain)
	}
}

func TestFormatCompactToolLine_FileEditWithDiff(t *testing.T) {
	// A simple unified diff with 3 additions, 1 deletion.
	diff := "--- a/foo.go\n+++ b/foo.go\n@@ -1,3 +1,5 @@\n line1\n+added line A\n+added line B\n+added line C\n-removed\n line3\n"
	out := FormatCompactToolLine(
		"FileEdit",
		mkJSON(t, map[string]any{"path": "foo.go"}),
		mkJSON(t, diff),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Edited foo.go") {
		t.Errorf("expected 'Edited foo.go', got: %q", plain)
	}
	if !strings.Contains(plain, "+3 -1") {
		t.Errorf("expected '+3 -1' diff stats, got: %q", plain)
	}
}

func TestFormatCompactToolLine_FileEditWithoutDiff(t *testing.T) {
	// No diff content in output → stats omitted gracefully.
	out := FormatCompactToolLine(
		"FileEdit",
		mkJSON(t, map[string]any{"path": "foo.go"}),
		mkJSON(t, map[string]any{"status": "success", "summary": "no changes"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Edited foo.go") {
		t.Errorf("expected 'Edited foo.go', got: %q", plain)
	}
	if strings.Contains(plain, "+") || strings.Contains(plain, "-") {
		// "-1" / "+0" must not appear when there's no diff content.
		// (The chevron and target may contain other chars; check only
		// for stat-shaped substrings.)
		if strings.Contains(plain, " +") || strings.Contains(plain, " -") {
			t.Errorf("did not expect diff stats, got: %q", plain)
		}
	}
}

func TestFormatCompactToolLine_Bash(t *testing.T) {
	out := FormatCompactToolLine(
		"Bash",
		mkJSON(t, map[string]any{"command": "bun run test"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Ran $ bun run test") {
		t.Errorf("expected 'Ran $ bun run test', got: %q", plain)
	}
}

// ux-fixes 2026-05-22 ux1.png-v2: "$" sigil for Bash now lives in its
// own segment so the renderer can color it distinctly from the verb.
// verbTargetDetails returns ("Ran", "$", "<cmd>", "") for Bash; other
// tools leave the sigil slot empty.
func TestVerbTargetDetails_BashSplitsSigil(t *testing.T) {
	v, sig, tgt, det := verbTargetDetails(
		"Bash",
		mkJSON(t, map[string]any{"command": "echo hi"}),
		mkJSON(t, map[string]any{"status": "success"}),
	)
	if v != "Ran" {
		t.Errorf("verb = %q, want 'Ran'", v)
	}
	if sig != "$" {
		t.Errorf("sigil = %q, want '$'", sig)
	}
	if tgt != "echo hi" {
		t.Errorf("target = %q, want 'echo hi'", tgt)
	}
	if det != "" {
		t.Errorf("details = %q, want empty", det)
	}
}

func TestVerbTargetDetails_NonBashHasEmptySigil(t *testing.T) {
	tests := []struct {
		tool  string
		input map[string]any
	}{
		{"FileRead", map[string]any{"path": "x.go"}},
		{"FileEdit", map[string]any{"path": "x.go"}},
		{"Grep", map[string]any{"pattern": "foo"}},
		{"WebFetch", map[string]any{"url": "https://x"}},
	}
	for _, tc := range tests {
		_, sig, _, _ := verbTargetDetails(
			tc.tool,
			mkJSON(t, tc.input),
			mkJSON(t, map[string]any{"status": "success"}),
		)
		if sig != "" {
			t.Errorf("%s: sigil = %q, want empty", tc.tool, sig)
		}
	}
}

func TestVerbTargetDetails_GrepHasDetailsForPath(t *testing.T) {
	v, sig, tgt, det := verbTargetDetails(
		"Grep",
		mkJSON(t, map[string]any{"pattern": "foo", "path": "src/"}),
		mkJSON(t, map[string]any{"status": "success"}),
	)
	if v != "Grep" {
		t.Errorf("verb = %q", v)
	}
	if sig != "" {
		t.Errorf("sigil = %q, want empty for Grep", sig)
	}
	if tgt != "'foo'" {
		t.Errorf("target = %q, want \"'foo'\"", tgt)
	}
	if det != "in src/" {
		t.Errorf("details = %q, want 'in src/'", det)
	}
}

func TestVerbTargetDetails_FileEditWithDiffPutsStatsInDetails(t *testing.T) {
	_, _, tgt, det := verbTargetDetails(
		"FileEdit",
		mkJSON(t, map[string]any{"path": "src/foo.go"}),
		mkJSON(t, "--- a\n+++ b\n@@ -1,1 +1,1 @@\n+added\n"),
	)
	if tgt != "src/foo.go" {
		t.Errorf("target = %q, want 'src/foo.go' (no stats mixed in)", tgt)
	}
	if det != "+1 -0" {
		t.Errorf("details = %q, want '+1 -0'", det)
	}
}

func TestFormatCompactToolLine_BashFlattensMultiline(t *testing.T) {
	out := FormatCompactToolLine(
		"Bash",
		mkJSON(t, map[string]any{"command": "cat <<EOF\nhello\nworld\nEOF"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		120,
	)
	plain := stripANSI(out)
	// Multi-line commands collapse to single line.
	if strings.Contains(plain, "\n") {
		t.Errorf("expected flattened single line, got: %q", plain)
	}
	// All the tokens still present.
	for _, want := range []string{"cat", "hello", "world", "EOF"} {
		if !strings.Contains(plain, want) {
			t.Errorf("expected token %q in flattened command: %q", want, plain)
		}
	}
}

func TestFormatCompactToolLine_Grep(t *testing.T) {
	out := FormatCompactToolLine(
		"Grep",
		mkJSON(t, map[string]any{"pattern": "tool_use_start", "path": "src/"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Grep 'tool_use_start' in src/") {
		t.Errorf("expected 'Grep 'tool_use_start' in src/', got: %q", plain)
	}
}

func TestFormatCompactToolLine_GrepNoPath(t *testing.T) {
	out := FormatCompactToolLine(
		"Grep",
		mkJSON(t, map[string]any{"pattern": "hello"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Grep 'hello'") {
		t.Errorf("expected 'Grep 'hello'', got: %q", plain)
	}
	if strings.Contains(plain, " in ") {
		t.Errorf("did not expect ' in ' when path absent: %q", plain)
	}
}

func TestFormatCompactToolLine_Glob(t *testing.T) {
	out := FormatCompactToolLine(
		"Glob",
		mkJSON(t, map[string]any{"pattern": "src/**/*.ts"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Glob 'src/**/*.ts'") {
		t.Errorf("expected 'Glob 'src/**/*.ts'', got: %q", plain)
	}
}

func TestFormatCompactToolLine_WebFetch(t *testing.T) {
	out := FormatCompactToolLine(
		"WebFetch",
		mkJSON(t, map[string]any{"url": "https://example.com/path/to/page"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		120,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Fetched https://example.com/path/to/page") {
		t.Errorf("expected fetched URL, got: %q", plain)
	}
}

func TestFormatCompactToolLine_WebFetchTruncatesLongURL(t *testing.T) {
	longURL := "https://example.com/a/very/deep/path/" + strings.Repeat("segment/", 20) + "end"
	out := FormatCompactToolLine(
		"WebFetch",
		mkJSON(t, map[string]any{"url": longURL}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		120,
	)
	plain := stripANSI(out)
	// Must contain host + ellipsis form, not the full long path.
	if !strings.Contains(plain, "https://example.com") {
		t.Errorf("expected host in truncated URL, got: %q", plain)
	}
	if strings.Contains(plain, "end") {
		t.Errorf("did not expect full tail in truncated URL, got: %q", plain)
	}
}

func TestFormatCompactToolLine_WebSearch(t *testing.T) {
	out := FormatCompactToolLine(
		"WebSearch",
		mkJSON(t, map[string]any{"query": "claude code"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Web search 'claude code'") {
		t.Errorf("expected 'Web search 'claude code'', got: %q", plain)
	}
}

func TestFormatCompactToolLine_MemoryView(t *testing.T) {
	out := FormatCompactToolLine(
		"memory",
		mkJSON(t, map[string]any{"action": "view", "file": "MEMORY.md"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Read memory MEMORY.md") {
		t.Errorf("expected 'Read memory MEMORY.md', got: %q", plain)
	}
}

func TestFormatCompactToolLine_MemoryReplace(t *testing.T) {
	out := FormatCompactToolLine(
		"memory",
		mkJSON(t, map[string]any{"action": "replace", "file": "USER.md", "content": "..."}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Wrote memory USER.md") {
		t.Errorf("expected 'Wrote memory USER.md', got: %q", plain)
	}
}

func TestFormatCompactToolLine_MemoryPropose(t *testing.T) {
	out := FormatCompactToolLine(
		"memory_propose",
		mkJSON(t, map[string]any{"name": "user-prefers-tabs"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Proposed memory 'user-prefers-tabs'") {
		t.Errorf("expected proposed memory line, got: %q", plain)
	}
}

func TestFormatCompactToolLine_SkillPropose(t *testing.T) {
	out := FormatCompactToolLine(
		"skill_propose",
		mkJSON(t, map[string]any{"name": "deploy-web"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Proposed skill 'deploy-web'") {
		t.Errorf("expected proposed skill line, got: %q", plain)
	}
}

func TestFormatCompactToolLine_MCPTool(t *testing.T) {
	out := FormatCompactToolLine(
		"mcp__notion__create_page",
		mkJSON(t, map[string]any{"title": "Hello", "parent": "abc123"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		120,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "notion: create_page") {
		t.Errorf("expected 'notion: create_page' prefix, got: %q", plain)
	}
}

func TestFormatCompactToolLine_AgentTool(t *testing.T) {
	out := FormatCompactToolLine(
		"AgentTool",
		mkJSON(t, map[string]any{"subagent_type": "delegator", "prompt": "Plan the work and dispatch atoms"}),
		mkJSON(t, map[string]any{"status": "success", "summary": "delegator → completed (3 turns, 2 tool calls)"}),
		theme.Dark(),
		120,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, "Dispatched delegator") {
		t.Errorf("expected 'Dispatched delegator', got: %q", plain)
	}
	if !strings.Contains(plain, "→ completed") {
		t.Errorf("expected '→ completed' in details, got: %q", plain)
	}
	if !strings.Contains(plain, CompactLineChevron) {
		t.Errorf("expected chevron, got: %q", plain)
	}
}

func TestFormatCompactToolLine_AgentToolError(t *testing.T) {
	out := FormatCompactToolLine(
		"AgentTool",
		mkJSON(t, map[string]any{"subagent_type": "frontier-task", "prompt": "Build a game"}),
		mkJSON(t, map[string]any{"status": "error", "summary": "frontier-task → interrupted (1 turns, 0 tool calls)"}),
		theme.Dark(),
		120,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, CompactLineErrorGlyph) {
		t.Errorf("expected error glyph for failed AgentTool, got: %q", plain)
	}
	if !strings.Contains(plain, "Dispatched frontier-task") {
		t.Errorf("expected 'Dispatched frontier-task', got: %q", plain)
	}
}

func TestVerbTargetDetails_AgentTool(t *testing.T) {
	v, sig, tgt, det := verbTargetDetails(
		"AgentTool",
		mkJSON(t, map[string]any{"subagent_type": "explore", "prompt": "find auth code"}),
		mkJSON(t, map[string]any{"status": "success", "summary": "explore → completed (2 turns, 1 tool calls)"}),
	)
	if v != "Dispatched" {
		t.Errorf("verb = %q, want 'Dispatched'", v)
	}
	if sig != "" {
		t.Errorf("sigil = %q, want empty", sig)
	}
	if tgt != "explore" {
		t.Errorf("target = %q, want 'explore'", tgt)
	}
	if !strings.Contains(det, "→ completed") {
		t.Errorf("details = %q, want to contain '→ completed'", det)
	}
}

func TestFormatCompactToolLine_LeftMarginPresent(t *testing.T) {
	out := FormatCompactToolLine(
		"FileRead",
		mkJSON(t, map[string]any{"path": "foo.go"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.HasPrefix(plain, CompactLineLeftMargin) {
		t.Errorf("expected left margin %q prefix, got: %q", CompactLineLeftMargin, plain)
	}
}

func TestFormatCompactToolLine_UnknownToolFallback(t *testing.T) {
	out := FormatCompactToolLine(
		"SomeFutureTool",
		mkJSON(t, map[string]any{"foo": "bar", "baz": 42}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		120,
	)
	plain := stripANSI(out)
	// Verb = tool name verbatim; target = input preview.
	if !strings.Contains(plain, "SomeFutureTool") {
		t.Errorf("expected fallback verb 'SomeFutureTool', got: %q", plain)
	}
}

func TestFormatCompactToolLine_ErrorEnvelope(t *testing.T) {
	// status:'error' triggers the ✗ glyph + red color.
	out := FormatCompactToolLine(
		"Bash",
		mkJSON(t, map[string]any{"command": "false"}),
		mkJSON(t, map[string]any{"status": "error", "summary": "exited 1"}),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, CompactLineErrorGlyph) {
		t.Errorf("expected ✗ glyph for error envelope, got: %q", plain)
	}
	if strings.Contains(plain, CompactLineDeniedGlyph) {
		t.Errorf("did not expect ⚠ for runtime error, got: %q", plain)
	}
}

func TestFormatCompactToolLine_PermissionDenied(t *testing.T) {
	// Orchestrator deny path emits Output as a JSON-quoted string
	// "permission denied: ...".
	deniedRaw := `"permission denied: rule deny matched"`
	out := FormatCompactToolLine(
		"FileEdit",
		mkJSON(t, map[string]any{"path": "/etc/passwd"}),
		json.RawMessage(deniedRaw),
		theme.Dark(),
		80,
	)
	plain := stripANSI(out)
	if !strings.Contains(plain, CompactLineDeniedGlyph) {
		t.Errorf("expected ⚠ glyph for permission denied, got: %q", plain)
	}
	if strings.Contains(plain, CompactLineErrorGlyph) {
		t.Errorf("did not expect ✗ for denied (denied wins), got: %q", plain)
	}
}

func TestDetectToolStatus_Success(t *testing.T) {
	isError, isDenied := DetectToolStatus(mkJSON(t, map[string]any{"status": "success", "summary": "ok"}))
	if isError {
		t.Errorf("expected isError=false for success envelope")
	}
	if isDenied {
		t.Errorf("expected isDenied=false for success envelope")
	}
}

func TestDetectToolStatus_Error(t *testing.T) {
	isError, isDenied := DetectToolStatus(mkJSON(t, map[string]any{"status": "error", "summary": "x"}))
	if !isError {
		t.Errorf("expected isError=true for error envelope")
	}
	if isDenied {
		t.Errorf("expected isDenied=false for runtime error (denied is separate)")
	}
}

func TestDetectToolStatus_PermissionDenied(t *testing.T) {
	isError, isDenied := DetectToolStatus(json.RawMessage(`"permission denied: x"`))
	if !isError {
		t.Errorf("expected isError=true for permission denied")
	}
	if !isDenied {
		t.Errorf("expected isDenied=true for permission denied")
	}
}

func TestDetectToolStatus_MalformedJSON(t *testing.T) {
	// Garbage input — should fall through to success.
	isError, isDenied := DetectToolStatus(json.RawMessage(`{not valid`))
	if isError || isDenied {
		t.Errorf("expected (false,false) for malformed JSON; got (%v,%v)", isError, isDenied)
	}
}

func TestFormatCompactToolLine_TruncatesLongTarget(t *testing.T) {
	// Very long path → truncated with ellipsis.
	longPath := "/very/" + strings.Repeat("deep-", 30) + "/path.txt"
	out := FormatCompactToolLine(
		"FileRead",
		mkJSON(t, map[string]any{"path": longPath}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		60,
	)
	plain := stripANSI(out)
	// Must fit in ~60 cols; certainly shouldn't contain the full long path.
	if len(plain) > 80 { // generous bound for ANSI-stripped form
		t.Errorf("expected truncated line ≤80 chars, got %d: %q", len(plain), plain)
	}
	if !strings.Contains(plain, "…") {
		t.Errorf("expected ellipsis on truncated line, got: %q", plain)
	}
}

func TestFormatCompactToolLine_NarrowTerminalDoesNotCrash(t *testing.T) {
	// Very narrow terminal — implementation should still produce
	// SOMETHING without crashing.
	out := FormatCompactToolLine(
		"FileRead",
		mkJSON(t, map[string]any{"path": "foo.go"}),
		mkJSON(t, map[string]any{"status": "success"}),
		theme.Dark(),
		4,
	)
	if out == "" {
		t.Errorf("narrow terminal: expected non-empty output")
	}
}

func TestFormatCompactToolLine_ChevronAlwaysPresent(t *testing.T) {
	// Every successful line ends with the chevron affordance.
	for _, tool := range []string{"FileRead", "FileWrite", "Bash", "Grep", "WebFetch"} {
		out := FormatCompactToolLine(
			tool,
			mkJSON(t, map[string]any{"path": "x", "command": "x", "pattern": "x", "url": "https://x"}),
			mkJSON(t, map[string]any{"status": "success"}),
			theme.Dark(),
			80,
		)
		plain := stripANSI(out)
		if !strings.Contains(plain, CompactLineChevron) {
			t.Errorf("tool %s: expected chevron in line, got: %q", tool, plain)
		}
	}
}
