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
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// DecodeOutputText unwraps a tool_result `output` blob into displayable
// text. The wire `output` is a JSON value: most commonly a JSON-encoded
// string (escaped \n, surrounding quotes) carrying the tool's plain-text
// result, but occasionally a structured envelope or raw bytes. This
// helper unmarshals a JSON string into its decoded form (real newlines,
// no surrounding quotes); on any failure it returns the raw bytes
// verbatim so a non-string payload still renders something.
//
// Shared by compact-line rendering AND app.go's detailed ToolCard /
// verbose-raw / /expand ring / DiffView paths so all consumers see the
// same decoded text — otherwise users would see one mega-line
// `"line1\nline2"` with quotes, and diff parsing would never find real
// newlines. FIX 3 (audit).
func DecodeOutputText(output json.RawMessage) string {
	if len(output) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(output, &asString); err == nil {
		return asString
	}
	return string(output)
}

func FormatCompactToolLine(
	tool string,
	input json.RawMessage,
	output json.RawMessage,
	t theme.Theme,
	width int,
) string {
	verb, sigil, target, details := verbTargetDetails(tool, input, output)
	isError, isDenied := DetectToolStatus(output)

	// Compose the rendered line as:
	//   [glyph ]<verb>[ <sigil>] <target>[ <details>]  ›
	//
	// Color buckets (ux-fixes 2026-05-22 ux2.png + ux1.png-v2):
	//   - verb (Read / Edited / Ran / …): brand purple — eye-catching,
	//     so a column of tool calls reads as a column of consistent
	//     verbs.
	//   - sigil ($ for Bash): theme.Success green, distinct from the
	//     verb so the shell-prompt indicator pops on its own. Empty
	//     for non-shell tools.
	//   - target (file path / command / pattern / URL / name):
	//     theme.Info — slightly muted from normal text so the line
	//     reads as recessive overall, but bright enough that the user
	//     can scan the relevant target at a glance.
	//   - details (diff stats "+11 -7", "in <path>", match counts):
	//     theme.Dim — most muted, supplementary context.
	//   - status glyph: theme.Warning for ⚠ (denied), theme.Error for ✗.
	//   - chevron: theme.Dim (unchanged).
	prefix := ""
	if isDenied {
		prefix = lipgloss.NewStyle().
			Foreground(t.Warning).
			Bold(true).
			Render(style.S.Glyph.Warning) + " "
	} else if isError {
		prefix = lipgloss.NewStyle().
			Foreground(t.Error).
			Bold(true).
			Render(style.S.Glyph.Error) + " "
	}

	margin := style.S.CompactLine.Indent
	marginWidth := visibleLen(margin)
	if width < 20 {
		margin = ""
		marginWidth = 0
	}

	// Width budget: account for the chevron ( + space + glyph), the
	// left margin, and the status prefix when present. Truncate the
	// target first; verb + sigil + details stay readable.
	reserved := 2 + marginWidth // chevron " ›" + margin
	if prefix != "" {
		reserved += 2 // glyph + space
	}
	plainBody := verb
	if sigil != "" {
		plainBody += " " + sigil
	}
	if target != "" {
		plainBody += " " + target
	}
	if details != "" {
		plainBody += " " + details
	}
	maxBody := width - reserved
	if maxBody >= 8 && visibleLen(plainBody) > maxBody {
		fixed := visibleLen(verb)
		if sigil != "" {
			fixed += 1 + visibleLen(sigil)
		}
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
			verbColor := lipgloss.Color(style.S.Brand.VerbColor)
			if tool == "AgentTool" {
				verbColor = lipgloss.Color(style.S.Brand.AccentColor)
			}
			return margin + prefix + lipgloss.NewStyle().Foreground(verbColor).Render(plainBody) + lipgloss.NewStyle().Foreground(t.Dim).Render(" "+style.S.CompactLine.Chevron)
		}
		target = truncateTail(target, availForTarget)
	}

	verbColor := lipgloss.Color(style.S.Brand.VerbColor)
	if tool == "AgentTool" {
		verbColor = lipgloss.Color(style.S.Brand.AccentColor)
	}
	verbStyled := lipgloss.NewStyle().
		Foreground(verbColor).
		Render(verb)
	body := verbStyled
	if sigil != "" {
		body += " " + lipgloss.NewStyle().
			Foreground(t.Success).
			Bold(true).
			Render(sigil)
	}
	if target != "" {
		body += " " + lipgloss.NewStyle().Foreground(t.Info).Render(target)
	}
	if details != "" {
		body += " " + lipgloss.NewStyle().Foreground(t.Dim).Render(details)
	}
	chevronStyled := lipgloss.NewStyle().Foreground(t.Dim).Render(" " + style.S.CompactLine.Chevron)
	return margin + prefix + body + chevronStyled
}

// DetectToolStatus inspects an Output blob and reports whether the
// tool errored at runtime (isError) and whether the error was a
// permission denial (isDenied).
//
// Three on-wire shapes are recognized (FIX 4, audit):
//
//  1. Phase 12.5+ plain-text result: the tool's text payload is
//     JSON-encoded into the wire `output` string. A failed tool emits a
//     "status: error\nsummary: ..." header as the FIRST line of that
//     text (Bash nonzero exit, FileEdit no-match, hook-denied). We
//     decode the JSON string (via DecodeOutputText) then test the
//     leading "status: error" header.
//  2. Legacy tool-emitted JSON envelope `{status:'error', summary, ...}`
//     — kept for any surface still emitting the structured shape.
//  3. Orchestrator deny path: text content "permission denied: <reason>"
//     (surfaced into Output as a quoted JSON string or raw text).
//
// Unknown shapes fall through to success.
func DetectToolStatus(output json.RawMessage) (isError, isDenied bool) {
	// Legacy structured envelope: try parsing the RAW bytes as an object
	// with a status field. Decoding into a string (shape 1) would fail
	// for an object, so this is only hit by a genuine JSON envelope.
	var env struct {
		Status  string `json:"status"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(output, &env); err == nil && env.Status == "error" {
		return true, false
	}
	// Decode the JSON-string payload (Phase 12.5+) so the plain-text
	// header checks below run against real, unquoted text.
	text := strings.TrimSpace(DecodeOutputText(output))
	// Permission denial path takes precedence over the generic error
	// glyph so the ⚠ (denied) shows instead of ✗ (runtime error).
	if strings.HasPrefix(text, "permission denied") {
		return true, true
	}
	// Plain-text error header: the failed-tool payload leads with a
	// "status: error" line. Match the first line so a later occurrence
	// of the phrase in tool output doesn't trigger a false positive.
	firstLine := text
	if i := strings.IndexByte(firstLine, '\n'); i >= 0 {
		firstLine = firstLine[:i]
	}
	if strings.HasPrefix(strings.TrimSpace(firstLine), "status: error") {
		return true, false
	}
	return false, false
}

// verbTargetDetails produces a 4-tuple for compact-line rendering:
//
//   - verb: the past-tense action ("Read", "Edited", "Ran", ...).
//     Rendered in the brand-purple verb color.
//   - sigil: an inline accent token (currently "$" for Bash). Rendered
//     in theme.Success green, distinct from both the verb and the
//     target. Empty for tools that don't have a shell-prompt-style
//     marker.
//   - target: the primary argument (file path, command, pattern, URL,
//     name). Rendered in theme.Info (slightly muted from default).
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
) (verb, sigil, target, details string) {
	switch tool {
	case "FileRead":
		return "Read", "", extractStringField(input, "path"), ""
	case "FileWrite":
		return "Wrote", "", extractStringField(input, "path"), ""
	case "FileEdit":
		return "Edited", "", extractStringField(input, "path"), extractDiffStats(output)
	case "Bash":
		// ux-fixes 2026-05-22 ux1.png-v2: pull "$" out of the verb so it
		// can render in its own accent (theme.Success green) rather than
		// the brand-purple verb color. The user wanted the shell-prompt
		// marker to pop on its own as a visual cue.
		return "Ran", "$", flattenWhitespace(extractStringField(input, "command")), ""
	case "Grep":
		pat := extractStringField(input, "pattern")
		path := extractStringField(input, "path")
		tgt := "'" + pat + "'"
		d := ""
		if path != "" {
			d = "in " + path
		}
		return "Grep", "", tgt, d
	case "Glob":
		pat := extractStringField(input, "pattern")
		path := extractStringField(input, "path")
		tgt := "'" + pat + "'"
		d := ""
		if path != "" {
			d = "in " + path
		}
		return "Glob", "", tgt, d
	case "WebFetch":
		return "Fetched", "", truncateURL(extractStringField(input, "url")), ""
	case "WebSearch":
		return "Web search", "", "'" + extractStringField(input, "query") + "'", ""
	case "memory":
		// Memory tool with action sub-field: view vs replace.
		action := extractStringField(input, "action")
		file := extractStringField(input, "file")
		switch action {
		case "view":
			return "Read memory", "", file, ""
		case "replace":
			return "Wrote memory", "", file, ""
		default:
			return "Memory", "", strings.TrimSpace(action + " " + file), ""
		}
	case "memory_propose":
		name := extractStringField(input, "name")
		if name == "" {
			name = extractStringField(input, "slug")
		}
		return "Proposed memory", "", "'" + name + "'", ""
	case "skill_propose":
		name := extractStringField(input, "name")
		if name == "" {
			name = extractStringField(input, "slug")
		}
		return "Proposed skill", "", "'" + name + "'", ""
	case "AgentTool":
		agentName := extractStringField(input, "subagent_type")
		if agentName == "" {
			agentName = "agent"
		}
		summary := extractStringField(output, "summary")
		details := ""
		if summary != "" {
			if idx := strings.Index(summary, "→"); idx >= 0 {
				details = strings.TrimSpace(summary[idx:])
			}
		}
		return "Dispatched", "", agentName, details
	}

	// MCP tools: name is `mcp__<server>__<tool>`.
	if strings.HasPrefix(tool, "mcp__") {
		v, tgt := formatMCPVerbAndTarget(tool, input)
		return v, "", tgt, ""
	}

	// Unknown tool fallback — verb is the tool name verbatim; target
	// is a flattened preview of the input.
	return tool, "", truncatePreview(string(input), style.S.CompactLine.PreviewMaxUnknown), ""
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
		return tool, truncatePreview(string(input), style.S.CompactLine.PreviewMaxUnknown)
	}
	server, name := parts[0], parts[1]
	verb = server + ":"
	preview := truncatePreview(string(input), style.S.CompactLine.PreviewMaxMCP)
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
	// embedded newlines). Shares DecodeOutputText with the other consumers.
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
	maxURL := style.S.CompactLine.URLMax
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
