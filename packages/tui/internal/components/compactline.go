// Package components — CompactLine: single-line rendering of a
// tool_result event in compact mode (the new 2026-05-22 default).
//
// Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md
//
// The compact line mirrors the Claude mobile app aesthetic:
//
//	Read README.md                       ›
//	Edited app.go +11 -7                 ›
//	Ran $ bun run test                   ›
//	⚠ Edit app.go                        ›   ← permission denied / cancelled
//	✗ Bash $ git push                    ›   ← runtime error (nonzero exit / error envelope)
//
// Verb mapping owned here (Approach A from the brainstorm — zero
// wire-schema churn). Per-tool input/output extractors pull the
// "target" (the relevant argument: file path, command, pattern, URL,
// memory file, etc.) and any "stats" (diff +/-, match count, ...).
//
// The chevron `›` is a pure visual cue that more detail is available;
// users can call /expand N to re-render the Nth-most-recent tool's
// raw payload below the prompt (existing affordance).

package components

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// CompactLineChevron is the trailing affordance glyph on every compact
// line. Exported so tests can assert its presence without hardcoding
// the literal across many test cases.
const CompactLineChevron = "›"

// CompactLineErrorGlyph prefixes a compact line when the tool's
// underlying output reports a runtime error (status:'error' envelope).
const CompactLineErrorGlyph = "✗"

// CompactLineDeniedGlyph prefixes a compact line when permission to
// run the tool was denied. The orchestrator deny branch emits a tool
// result with bare-text "permission denied: <reason>" content.
const CompactLineDeniedGlyph = "⚠"

// FormatCompactToolLine renders a single-line compact representation
// of a tool_result event, including any status-prefix glyph and the
// trailing chevron. All styling is baked in; the caller can m.print
// the return value directly into terminal scrollback.
//
// width is the terminal width in columns; the rendered line will fit
// within this minus a small margin.
//
// Status detection happens internally via DetectToolStatus.
// CompactLineVerbColor is the brand-purple hex used to color the
// verb segment of a compact tool line ("Read", "Edited", "Ran", …).
// Pinned to the SOV gradient's "soft purple" anchor — same anchor as
// ToolCardHeaderColor — so the verb reads as on-brand purple/pink
// across every theme. See docs/conventions/tui-color-rendering.md for
// the "accents that must read as a specific shade family get a fixed
// hex, not a theme token" rule.
const CompactLineVerbColor = "#a78bfa"

func FormatCompactToolLine(
	tool string,
	input json.RawMessage,
	output json.RawMessage,
	t theme.Theme,
	width int,
) string {
	verb, target, details := verbTargetDetails(tool, input, output)
	isError, isDenied := DetectToolStatus(output)

	// Compose the rendered line as:
	//   [glyph ]<verb> <target>[ <details>]  ›
	// Width budget: total ≤ width - 2 (small right margin). Truncation
	// drops the target first via tail-truncation so the verb + glyph stay
	// readable.
	//
	// Colors (ux-fixes 2026-05-22 ux2.png):
	//   - verb: fixed brand purple (CompactLineVerbColor) — distinguishes
	//     the action from the target so users can skim a column of
	//     tool calls and pick out "Edited / Ran / Grep" at a glance.
	//   - target: terminal-default foreground — files/commands/patterns
	//     read as the primary content of the line.
	//   - details: theme.Dim — supplementary stats ("+11 -7", "in src/")
	//     are recessive so they don't compete with the target.
	//   - status glyph: theme.Warning for ⚠ (denied), theme.Error for ✗.
	//   - chevron: theme.Dim (unchanged).
	prefix := ""
	if isDenied {
		prefix = lipgloss.NewStyle().
			Foreground(t.Warning).
			Bold(true).
			Render(CompactLineDeniedGlyph) + " "
	} else if isError {
		prefix = lipgloss.NewStyle().
			Foreground(t.Error).
			Bold(true).
			Render(CompactLineErrorGlyph) + " "
	}

	// Width budget: account for the chevron ( + space + glyph) and the
	// status prefix when present. Truncate the target first; verb +
	// details stay readable.
	reserved := 2 // chevron " ›"
	if prefix != "" {
		reserved += 2 // glyph + space
	}
	plainBody := verb
	if target != "" {
		plainBody += " " + target
	}
	if details != "" {
		plainBody += " " + details
	}
	maxBody := width - reserved
	if maxBody >= 8 && visibleLen(plainBody) > maxBody {
		// Truncate the target so the verb + details stay intact. Compute
		// how much we can keep of the target.
		// Layout: "<verb> <target>[ <details>]".
		fixed := visibleLen(verb)
		if details != "" {
			fixed += 1 + visibleLen(details)
		}
		if target != "" {
			fixed += 1 // leading space before target
		}
		availForTarget := maxBody - fixed
		if availForTarget < 4 {
			// Not enough room — fall back to whole-line tail truncation.
			plainBody = truncateTail(plainBody, maxBody)
			return prefix + lipgloss.NewStyle().Foreground(lipgloss.Color(CompactLineVerbColor)).Render(plainBody) + lipgloss.NewStyle().Foreground(t.Dim).Render(" "+CompactLineChevron)
		}
		target = truncateTail(target, availForTarget)
	}

	verbStyled := lipgloss.NewStyle().
		Foreground(lipgloss.Color(CompactLineVerbColor)).
		Render(verb)
	body := verbStyled
	if target != "" {
		// Terminal default foreground — no Color set. Per the color
		// convention this is the brightest, most-readable on any palette.
		body += " " + target
	}
	if details != "" {
		body += " " + lipgloss.NewStyle().Foreground(t.Dim).Render(details)
	}
	chevronStyled := lipgloss.NewStyle().Foreground(t.Dim).Render(" " + CompactLineChevron)
	return prefix + body + chevronStyled
}

// DetectToolStatus inspects an Output blob and reports whether the
// tool errored at runtime (isError) and whether the error was a
// permission denial (isDenied).
//
// Two on-wire shapes are recognized:
//
//  1. Tool-emitted JSON envelope `{status:'error', summary, ...}` —
//     e.g., FileRead on missing file, Bash on nonzero exit.
//  2. Orchestrator deny path: bare text content "permission denied:
//     <reason>" (Anthropic content-block format, surfaced into Output
//     as a quoted JSON string).
//
// Unknown shapes fall through to success.
func DetectToolStatus(output json.RawMessage) (isError, isDenied bool) {
	// Try parsing as an envelope.
	var env struct {
		Status  string `json:"status"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(output, &env); err == nil && env.Status == "error" {
		return true, false
	}
	// Permission denial path — bare text "permission denied: ...".
	// Output may be a JSON-string literal (with surrounding quotes)
	// or raw text; tolerate both.
	raw := strings.TrimSpace(string(output))
	raw = strings.TrimPrefix(raw, `"`)
	if strings.HasPrefix(raw, "permission denied") {
		return true, true
	}
	return false, false
}

// verbTargetDetails produces a 3-tuple for compact-line rendering:
//
//   - verb: the past-tense action ("Read", "Edited", "Ran $", ...).
//     Rendered in the brand-purple verb color.
//   - target: the primary argument (file path, command, pattern, URL,
//     name). Rendered in the terminal-default foreground — this is what
//     the user is most interested in scanning.
//   - details: supplementary context — diff stats ("+11 -7"), search
//     scope ("in src/"), match counts. Rendered in theme.Dim so it
//     recedes visually.
//
// Empty strings are allowed; only non-empty pieces appear in the output.
// Unknown tools fall back to the wire tool name + a short input preview.
func verbTargetDetails(
	tool string,
	input json.RawMessage,
	output json.RawMessage,
) (verb, target, details string) {
	switch tool {
	case "FileRead":
		return "Read", extractStringField(input, "path"), ""
	case "FileWrite":
		return "Wrote", extractStringField(input, "path"), ""
	case "FileEdit":
		return "Edited", extractStringField(input, "path"), extractDiffStats(output)
	case "Bash":
		return "Ran $", flattenWhitespace(extractStringField(input, "command")), ""
	case "Grep":
		pat := extractStringField(input, "pattern")
		path := extractStringField(input, "path")
		t := "'" + pat + "'"
		d := ""
		if path != "" {
			d = "in " + path
		}
		return "Grep", t, d
	case "Glob":
		pat := extractStringField(input, "pattern")
		path := extractStringField(input, "path")
		t := "'" + pat + "'"
		d := ""
		if path != "" {
			d = "in " + path
		}
		return "Glob", t, d
	case "WebFetch":
		return "Fetched", truncateURL(extractStringField(input, "url")), ""
	case "WebSearch":
		return "Web search", "'" + extractStringField(input, "query") + "'", ""
	case "memory":
		// Memory tool with action sub-field: view vs replace.
		action := extractStringField(input, "action")
		file := extractStringField(input, "file")
		switch action {
		case "view":
			return "Read memory", file, ""
		case "replace":
			return "Wrote memory", file, ""
		default:
			return "Memory", strings.TrimSpace(action + " " + file), ""
		}
	case "memory_propose":
		name := extractStringField(input, "name")
		if name == "" {
			name = extractStringField(input, "slug")
		}
		return "Proposed memory", "'" + name + "'", ""
	case "skill_propose":
		name := extractStringField(input, "name")
		if name == "" {
			name = extractStringField(input, "slug")
		}
		return "Proposed skill", "'" + name + "'", ""
	}

	// MCP tools: name is `mcp__<server>__<tool>`.
	if strings.HasPrefix(tool, "mcp__") {
		v, t := formatMCPVerbAndTarget(tool, input)
		return v, t, ""
	}

	// Unknown tool fallback — verb is the tool name verbatim; target
	// is a flattened preview of the input.
	return tool, truncatePreview(string(input), 40), ""
}

// formatMCPVerbAndTarget renders MCP tool calls as
//
//	"<server>:" + " " + "<toolname> <input-preview>"
//
// where server + toolname are extracted from the `mcp__<server>__<tool>`
// naming convention. Falls back to the raw tool name if the convention
// doesn't match.
func formatMCPVerbAndTarget(tool string, input json.RawMessage) (verb, target string) {
	rest := strings.TrimPrefix(tool, "mcp__")
	parts := strings.SplitN(rest, "__", 2)
	if len(parts) != 2 {
		return tool, truncatePreview(string(input), 40)
	}
	server, name := parts[0], parts[1]
	verb = server + ":"
	preview := truncatePreview(string(input), 32)
	if preview != "" {
		target = name + " " + preview
	} else {
		target = name
	}
	return verb, target
}

// extractStringField pulls a top-level string field from a JSON object
// blob. Returns "" if the blob isn't an object or the field is absent
// / non-string. Tolerates malformed JSON by returning "".
func extractStringField(blob json.RawMessage, field string) string {
	if len(blob) == 0 {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal(blob, &obj); err != nil {
		return ""
	}
	if v, ok := obj[field].(string); ok {
		return v
	}
	return ""
}

// extractDiffStats counts the +N -M lines in a tool's Output when the
// output is (or contains) a unified diff. Returns "" when no diff
// hunks are present (e.g., write-with-no-change cases).
//
// Heuristic: scan the Output as a string, count lines starting with
// "+ " or just "+" (excluding the "+++ " header) and "- " / "-"
// (excluding the "--- " header). Robust to both raw-diff output and
// JSON-quoted output (extraction strips surrounding quotes + decodes
// common escape sequences).
func extractDiffStats(output json.RawMessage) string {
	if len(output) == 0 {
		return ""
	}
	text := string(output)
	// Try unmarshaling as a JSON string envelope; if it works, use the
	// decoded form (which strips surrounding quotes + un-escapes
	// embedded newlines).
	var asString string
	if err := json.Unmarshal(output, &asString); err == nil {
		text = asString
	} else {
		// Or as a {status, summary, diff/output, ...} object — pull the
		// `diff` or `output` field as the diff text.
		var obj struct {
			Diff   string `json:"diff"`
			Output string `json:"output"`
		}
		if err := json.Unmarshal(output, &obj); err == nil {
			if obj.Diff != "" {
				text = obj.Diff
			} else if obj.Output != "" {
				text = obj.Output
			}
		}
	}

	added, deleted := 0, 0
	for _, line := range strings.Split(text, "\n") {
		// Skip headers.
		if strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---") {
			continue
		}
		if strings.HasPrefix(line, "+") {
			added++
			continue
		}
		if strings.HasPrefix(line, "-") {
			deleted++
			continue
		}
	}
	if added == 0 && deleted == 0 {
		return ""
	}
	return fmt.Sprintf("+%d -%d", added, deleted)
}

// truncateURL clips a URL to host + first path segment + ellipsis when
// it exceeds a reasonable column budget for the compact line. Empty
// input returns "".
func truncateURL(url string) string {
	if url == "" {
		return ""
	}
	const maxURL = 60
	if len(url) <= maxURL {
		return url
	}
	// Best-effort cut at the next '/' after the scheme prefix.
	scheme := ""
	rest := url
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(url, prefix) {
			scheme = prefix
			rest = strings.TrimPrefix(url, prefix)
			break
		}
	}
	// Keep scheme + host + first path segment.
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return truncateTail(url, maxURL)
	}
	host := rest[:slash]
	pathTail := rest[slash:]
	pathSeg := pathTail
	if next := strings.Index(pathTail[1:], "/"); next > 0 {
		pathSeg = pathTail[:next+1]
	}
	candidate := scheme + host + pathSeg + "…"
	if len(candidate) <= maxURL {
		return candidate
	}
	return truncateTail(url, maxURL)
}

// flattenWhitespace replaces runs of whitespace (including newlines)
// with a single space and trims surrounding whitespace. The compact
// line is a single visual line; multi-line tool inputs (e.g., a Bash
// heredoc) flatten to one line.
func flattenWhitespace(s string) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	prevSpace := true
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return strings.TrimSpace(b.String())
}

// truncateTail clips s to <= max visible chars, appending "…" when
// truncation occurs. max <= 1 returns the first character or "".
func truncateTail(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if visibleLen(s) <= max {
		return s
	}
	if max <= 1 {
		if len(s) == 0 {
			return ""
		}
		return string([]rune(s)[0])
	}
	// Take first max-1 runes + ellipsis.
	runes := []rune(s)
	if len(runes) <= max-1 {
		return s
	}
	return string(runes[:max-1]) + "…"
}

// visibleLen returns the rune count of s. Used as a stand-in for
// terminal column width on text without ANSI escape sequences. The
// compact-line builder works on unstyled body text before lipgloss
// wraps it, so this approximation is exact for normal Latin/ASCII
// content and close enough for most CJK characters used in tool
// arguments (file paths, commands, queries).
func visibleLen(s string) int {
	n := 0
	for range s {
		n++
	}
	return n
}
