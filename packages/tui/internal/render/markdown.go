// Package render — glamour-driven markdown rendering for the TUI.
//
// HARD RULE: do NOT set a foreground color for body-text glamour
// fields (Document, Paragraph, Text, List items, Strong, Emph,
// CodeBlock body, table body, definition descriptions). The terminal
// default foreground is the reliable bright path; every hex / ANSI
// "bright white" value can render DIM in some user's terminal because
// of palette customization or tmux 256-color quantization. The full
// rationale + iteration narrative lives at
// docs/conventions/tui-color-rendering.md. Trying to "fix dim text by
// picking a brighter color" cost 6 commits (M11.5 → M11.10) before
// we settled on the right model. Don't repeat.
//
// Accent fields (headings, links, inline code, errors, diff added/
// removed, code keywords, comments, blockquotes, horizontal rules)
// keep their theme colors because they need to be DIFFERENT from
// body text, not just bright.

package render

import (
	"regexp"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/ansi"
	"github.com/charmbracelet/lipgloss"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/style"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// Markdown renders Github-flavored markdown via glamour. Falls back to
// Plain on any glamour error so the TUI never crashes on garbage input
// from the model. Width is the wrap column (glamour's WordWrap).
//
// M11.1 — uses a theme-driven custom StyleConfig (see styleForTheme).
// M11.12 — pre-processes the input to wrap file-path-shaped tokens in
// backticks so the inline Code style (light-blue bold) auto-applies.
// Models inconsistently use backticks for file refs; this pass makes
// the formatting consistent without depending on prompt engineering.
func Markdown(text string, t theme.Theme, width int) string {
	if text == "" {
		return ""
	}
	if width <= 0 {
		return text
	}
	text = wrapFileRefs(text)
	style := styleForTheme(t)
	r, err := glamour.NewTermRenderer(
		glamour.WithStyles(style),
		glamour.WithWordWrap(width),
	)
	if err != nil {
		return Plain(text, t, width)
	}
	out, err := r.Render(text)
	if err != nil {
		return Plain(text, t, width)
	}
	out = splitSmashedTableHeader(out)
	return foldOrphanLines(out, width)
}

// splitSmashedTableHeader undoes a glamour v1.0.0 bug where a markdown
// table's header row and separator row are emitted on the SAME line:
//
//	" Tool      │ What it did ─────────┼─────────"
//
// instead of the correct two-line form:
//
//	" Tool      │ What it did       "
//	"───────────┼───────────────────"
//
// Detection: a line that contains BOTH `│` (column separator) AND `┼`
// (cross intersection) is smashed. The `┼` is the marker that a
// separator row got concatenated onto the header. Reconstruction:
//
//   - Find the position of the first `│` in the line — that's the
//     column-separator column.
//   - Find the start of the `─` run after the header's column-2 text
//     (everything from there is the separator row's content).
//   - Truncate the smashed line at the `─`-run start → that's the
//     header row.
//   - Build a clean separator row: `─` × header_width, with `┼` at the
//     column-separator position. Inserted as a new line right after
//     the header.
//
// Multi-column tables (3+ columns) work the same way: any `┼` on the
// line is a separator-row intersection; we rebuild with `┼` at every
// `│` position from the header.
//
// ux-fixes 2026-05-22 (ux1.png-v2): glamour bug repro at width 60:
//
//	"| Tool | What it did |\n|------|-------------|\n| bash | ran |\n"
//
// rendered as a single 101-char header line concatenated with 28 dashes
// + `┼` + 28 dashes — visually broken at every terminal width. This
// post-processor splits it into the two-line form glamour should have
// produced.
func splitSmashedTableHeader(rendered string) string {
	lines := strings.Split(rendered, "\n")
	out := make([]string, 0, len(lines)+4)
	for _, line := range lines {
		if !looksLikeSmashedTableHeader(line) {
			out = append(out, line)
			continue
		}
		header, sep, ok := splitSmashedLine(line)
		if !ok {
			out = append(out, line)
			continue
		}
		out = append(out, header, sep)
	}
	return strings.Join(out, "\n")
}

// looksLikeSmashedTableHeader returns true when a line has both `│`
// and `┼` — the signature of a header row concatenated with a
// separator row.
func looksLikeSmashedTableHeader(line string) bool {
	return strings.ContainsRune(line, '│') && strings.ContainsRune(line, '┼')
}

// splitSmashedLine pulls the header row and the separator row out of
// a smashed glamour table line. Returns (header, separator, true) on
// success or ("", "", false) if the line doesn't match the expected
// pattern (defensive — we'd rather pass through a weird shape than
// mangle it).
func splitSmashedLine(line string) (header, separator string, ok bool) {
	runes := []rune(line)
	// Find the column-separator columns (positions of `│`).
	var colPositions []int
	for i, r := range runes {
		if r == '│' {
			colPositions = append(colPositions, i)
		}
	}
	if len(colPositions) == 0 {
		return "", "", false
	}
	// Find the start of the contiguous `─` run that precedes the first
	// `┼`. Everything from there onward is the smashed separator row.
	firstCross := -1
	for i, r := range runes {
		if r == '┼' {
			firstCross = i
			break
		}
	}
	if firstCross < 0 {
		return "", "", false
	}
	dashStart := firstCross
	for dashStart > 0 && (runes[dashStart-1] == '─' || runes[dashStart-1] == ' ') {
		dashStart--
		if runes[dashStart] == ' ' {
			// We've left the dash run; back up one to point at the
			// first dash.
			dashStart++
			break
		}
	}
	// Walk forward to find the first dash (skip the trailing-space
	// region between header text and the dash run).
	for dashStart < firstCross && runes[dashStart] != '─' {
		dashStart++
	}
	if dashStart >= firstCross {
		return "", "", false
	}
	// Header row: everything before the dash run.
	header = strings.TrimRight(string(runes[:dashStart]), " \t")
	// Separator row: a clean `─` × header-width with `┼` at every
	// column-separator position from the header.
	headerRunes := []rune(header)
	sepRunes := make([]rune, len(headerRunes))
	for i := range sepRunes {
		sepRunes[i] = '─'
	}
	for _, p := range colPositions {
		if p < len(sepRunes) {
			sepRunes[p] = '┼'
		}
	}
	separator = string(sepRunes)
	return header, separator, true
}

// foldOrphanLines folds single-word lines back into the preceding line.
// ux-fixes 2026-05-22 (ux4.png): glamour v1.0.0's WithWordWrap
// occasionally produces orphan single-word lines at specific widths
// (e.g., at width 115 the input "...what the spec asked for..."
// rendered as "...the spec asked for,\nand\nhere's why..."). The
// orphan is a single short word that could have fit on the previous
// or next line; glamour's wrap math gets it wrong at edge cases. This
// helper detects those single-word lines and merges them into the
// previous line.
//
// Heuristic for "single-word line":
//   - The trimmed line content (after stripping trailing spaces and
//     ANSI codes) contains exactly one whitespace-separated token.
//   - The line is NOT a list bullet, blockquote marker, heading,
//     code-fence delimiter, or table row.
//   - There IS a preceding non-empty content line to fold into (no
//     paragraph break / blank line between them).
//
// Conservative: skips lines containing structural markdown chrome.
// Worst case it leaves an orphan in place — no false-positive
// merges.
//
// FIX 5 (audit) — width is the render (wrap) column. A fold is only
// performed when the merged line still fits within width; otherwise the
// merge would produce a line wider than the terminal, which the terminal
// then re-wraps (visual overflow artifacts). width <= 0 disables the
// fit check (treat as unbounded) so callers without a known width keep
// the prior fold-always behavior.
func foldOrphanLines(rendered string, width int) string {
	lines := strings.Split(rendered, "\n")
	if len(lines) < 2 {
		return rendered
	}
	// Two-pass: first pass marks orphans, second pass merges. Going
	// top-down so each orphan folds into the most-recent non-orphan
	// content line above it.
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		// Strip ANSI for content analysis but keep the original line
		// intact for re-emission (merging preserves whatever ANSI runs
		// the orphan carried).
		plainTrim := strings.TrimRight(stripAnsiForFold(line), " \t")
		plainTrim = strings.TrimLeft(plainTrim, " \t")
		if plainTrim == "" {
			continue
		}
		if isStructuralLine(plainTrim) {
			continue
		}
		// Single-word test: split on whitespace and count non-empty.
		fields := strings.Fields(plainTrim)
		if len(fields) != 1 {
			continue
		}
		// Find the previous non-empty content line to merge into.
		j := i - 1
		for j >= 0 {
			prev := strings.TrimRight(stripAnsiForFold(lines[j]), " \t")
			prev = strings.TrimLeft(prev, " \t")
			if prev == "" {
				break // blank line — paragraph break, don't cross
			}
			if isStructuralLine(prev) {
				break
			}
			// Found a content line; merge.
			break
		}
		if j < 0 {
			continue
		}
		prev := lines[j]
		prevTrim := strings.TrimRight(stripAnsiForFold(prev), " \t")
		prevTrim = strings.TrimLeft(prevTrim, " \t")
		if prevTrim == "" || isStructuralLine(prevTrim) {
			continue
		}
		// Merge: append " " + orphan-word onto the previous line.
		// Preserve the previous line's trailing ANSI reset (if any) by
		// adding the orphan content before any padding.
		orphanWord := strings.TrimSpace(line)
		prevRightTrimmed := strings.TrimRight(prev, " \t")
		// FIX 5 (audit) — only fold into the previous line when the merged
		// line still fits the render width. lipgloss.Width measures
		// visible columns (ANSI stripped). When the previous-line merge
		// would exceed width, try folding into the NEXT content line
		// instead (prepend the word) — that removes the orphan WITHOUT
		// producing an over-width line. If neither fits, leave the orphan
		// in place rather than overflow.
		fitsPrev := width <= 0 ||
			lipgloss.Width(prevRightTrimmed)+1+lipgloss.Width(orphanWord) <= width
		if fitsPrev {
			lines[j] = prevRightTrimmed + " " + orphanWord
			// Remove the orphan line.
			lines = append(lines[:i], lines[i+1:]...)
			i-- // re-check this index in case the new line is now orphaned
			continue
		}
		// Previous-line merge overflows — attempt the next content line.
		if foldedIntoNext := tryFoldIntoNextLine(lines, i, orphanWord, width); foldedIntoNext {
			lines = append(lines[:i], lines[i+1:]...)
			i-- // the removed orphan shifts indices; re-check this slot
			continue
		}
		// No fold possible without overflow — leave the orphan as-is.
	}
	return strings.Join(lines, "\n")
}

// tryFoldIntoNextLine prepends orphanWord to the first following content
// line (the line after the orphan at index i) when that line exists, is
// non-structural, is not separated by a blank line (same paragraph), and
// the prepended result still fits within width. Returns true when it
// folded (mutating lines in place). FIX 5 (audit) — the next-line escape
// hatch so an orphan that can't fold UP without overflowing still folds
// DOWN, eliminating the orphan without producing an over-width line.
func tryFoldIntoNextLine(lines []string, i int, orphanWord string, width int) bool {
	if i+1 >= len(lines) {
		return false
	}
	next := lines[i+1]
	nextTrim := strings.TrimLeft(strings.TrimRight(stripAnsiForFold(next), " \t"), " \t")
	if nextTrim == "" || isStructuralLine(nextTrim) {
		return false
	}
	nextLeftTrimmed := strings.TrimLeft(next, " \t")
	if width > 0 &&
		lipgloss.Width(orphanWord)+1+lipgloss.Width(strings.TrimRight(nextLeftTrimmed, " \t")) > width {
		return false
	}
	lines[i+1] = orphanWord + " " + nextLeftTrimmed
	return true
}

// stripAnsiForFold removes ANSI CSI/OSC escape sequences for the
// purpose of orphan detection. Not exported because compactline.go has
// its own stripANSI helper for a different use case (tests strip
// rendered output); keeping the implementations local lets each one
// evolve independently.
func stripAnsiForFold(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) {
				c := s[j]
				if c >= '@' && c <= '~' {
					j++
					break
				}
				j++
			}
			i = j - 1
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// isStructuralLine reports whether a line is markdown chrome (list
// bullet, blockquote, heading, code fence, table row/separator) that
// the orphan-fold pass should leave alone. The check runs against the
// trimmed, ANSI-stripped line content.
func isStructuralLine(s string) bool {
	if s == "" {
		return true
	}
	// Table separator row — all box-drawing chars (─, ┼, ┌, ┐, └, ┘,
	// ├, ┤, ┬, ┴, │). This catches both glamour-emitted separators and
	// the splitSmashedTableHeader-reconstructed ones. Without this
	// check, foldOrphanLines would treat a dash-only line as a
	// single-word orphan and merge it back into the header it was
	// just split from.
	if isBoxDrawingOnly(s) {
		return true
	}
	// List bullets: "- ", "* ", "+ ", numbered "1. " etc.
	if len(s) >= 2 && (s[0] == '-' || s[0] == '*' || s[0] == '+') && s[1] == ' ' {
		return true
	}
	if strings.HasPrefix(s, "• ") {
		return true
	}
	// Headings.
	if s[0] == '#' {
		return true
	}
	// Blockquote.
	if s[0] == '>' || strings.HasPrefix(s, "│") {
		return true
	}
	// Code fence.
	if strings.HasPrefix(s, "```") || strings.HasPrefix(s, "~~~") {
		return true
	}
	// Table row.
	if strings.HasPrefix(s, "|") {
		return true
	}
	return false
}

// isBoxDrawingOnly reports whether every rune in s is a box-drawing
// character (the U+2500..U+257F range) or whitespace. Used to recognise
// table separator rows so the orphan-fold pass doesn't mistakenly
// merge them.
func isBoxDrawingOnly(s string) bool {
	hasContent := false
	for _, r := range s {
		if r == ' ' || r == '\t' {
			continue
		}
		hasContent = true
		if r < 0x2500 || r > 0x257F {
			return false
		}
	}
	return hasContent
}

// fileRefPattern matches file-reference tokens that should be styled
// as inline code so they pick up the M11.11 light-blue bold treatment:
//
//   - Paths starting with /, ~/, ./, ../ followed by non-space chars
//     (e.g., /Users/julie/x, ~/code/foo, ./script.sh, ../README.md)
//   - Bare filenames ending in a recognized extension (e.g., foo.png,
//     hello.go, config.yaml)
//
// Word boundaries on both ends keep the regex from grabbing into
// surrounding prose. The extension list below is shared by both the
// prose token-matcher (fileRefPattern) and the bullet whole-content
// matcher (fileExtensionTailPattern) so the two never drift apart.
//
// fileExtensionGroup is the alternation body of recognized file
// extensions, grouped by category. It deliberately covers the kinds of
// names a user sees in a real file listing — not just source code —
// because the prior code-only list left documents, media, and archives
// (pdf, mov, zip, …) unhighlighted next to their lit-up .png/.md/.txt
// neighbors (us1.png feedback, 2026-06-11). Kept conservative: every
// entry is a genuine extension shape, matched only after a literal dot
// with word boundaries, so prose false positives stay rare.
const fileExtensionGroup = `` +
	// images
	`png|jpe?g|gif|svg|webp|ico|bmp|tiff?|heic|heif|avif|` +
	// documents
	`md|mdx|txt|rtf|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|epub|pages|numbers|key|` +
	// data / config
	`json|ya?ml|toml|csv|tsv|log|xml|conf|cfg|ini|env|lock|db|sqlite3?|parquet|ipynb|` +
	// archives / disk images
	`zip|tar|gz|tgz|bz2|xz|zst|7z|rar|dmg|pkg|iso|deb|rpm|` +
	// audio / video
	`mov|mp4|m4v|avi|mkv|webm|mpe?g|mp3|m4a|wav|flac|aac|ogg|opus|` +
	// source code
	`go|ts|tsx|js|jsx|mjs|cjs|py|rs|sh|bash|zsh|fish|html?|css|scss|sass|sql|` +
	`c|cc|cpp|cxx|h|hpp|java|kt|rb|php|swift|mm?|vue|svelte|astro|dart|scala|clj|ex|exs|lua|tf|proto|` +
	// dotfile-style names
	`gitignore|gitattributes|dockerfile|makefile`

var fileRefPattern = regexp.MustCompile(
	`(?:^|[\s(\[{"'])((?:/|~/|\./|\.\./)[\w./\-]+|[\w\-][\w\-.]*\.(?:` + fileExtensionGroup + `))(?:$|[\s),.!?:;\]}"'])`,
)

// fileExtensionTailPattern matches the trailing portion of a string that
// looks like a known file extension. Used to confirm a markdown list
// item's content is a filename (multi-word filenames need to be
// recognized as a unit, since fileRefPattern is constrained to
// space-free tokens).
var fileExtensionTailPattern = regexp.MustCompile(
	`\.(?:` + fileExtensionGroup + `)$`,
)

// listBulletPattern matches a markdown list-item prefix:
// optional indent, then "- " or "* " or "+ ".
var listBulletPattern = regexp.MustCompile(`^(\s*[-*+]\s+)(.*)$`)

// tableRowPattern matches a markdown table row: optional leading
// whitespace, a leading `|`, at least one interior `|`, and a trailing
// `|` (with optional trailing whitespace). Used to enable the
// table-cell awareness pass in wrapFileRefsByLine so multi-word
// filenames sitting in a table cell pick up the inline-code styling
// (the token-level fileRefPattern is constrained to space-free tokens
// and can't see "Babyboard logo circulat.png" as a single ref).
//
// ux-fixes round 2.
var tableRowPattern = regexp.MustCompile(`^\s*\|.+\|.*\|\s*$`)

// tableSeparatorCellPattern matches the content of a separator-row
// cell after trimming — only dashes, colons (alignment markers), and
// whitespace. Used to skip the `|---|:---:|---|` row that sits
// between a table header and its body so we don't accidentally treat
// dashes as filename content.
var tableSeparatorCellPattern = regexp.MustCompile(`^[-:\s]+$`)

// wrapFileRefs wraps detected file-reference tokens in backticks so
// glamour renders them via the inline-Code style. Two-pass approach:
//
//  1. For each line, if it's a markdown bullet ("- foo bar.png")
//     whose content ends in a recognized file extension, wrap the
//     ENTIRE bullet content in backticks. This handles filenames
//     with spaces (very common in user-facing file listings).
//
//  2. For lines that don't match the bullet shape, fall through to
//     the token-level fileRefPattern regex which catches paths and
//     space-free filenames anywhere in prose.
//
// Both passes skip content already inside backtick spans (single or
// triple) so we don't double-wrap and don't modify fenced code
// blocks. M11.13.
func wrapFileRefs(text string) string {
	fenced := strings.Split(text, "```")
	for i := range fenced {
		if i%2 == 1 {
			// Inside a fenced code block; preserve verbatim.
			continue
		}
		fenced[i] = wrapFileRefsOutsideBackticks(fenced[i])
	}
	return strings.Join(fenced, "```")
}

// wrapFileRefsOutsideBackticks processes a segment that sits outside
// triple-backtick fences. Splits on single backticks so inline-code
// spans are also preserved; the segments BETWEEN backticks get the
// line-based pass.
func wrapFileRefsOutsideBackticks(text string) string {
	parts := strings.Split(text, "`")
	for i := range parts {
		if i%2 == 1 {
			// Inside an inline backtick span; preserve verbatim.
			continue
		}
		parts[i] = wrapFileRefsByLine(parts[i])
	}
	return strings.Join(parts, "`")
}

// wrapFileRefsByLine processes a backtick-free segment line by line.
// Three passes, in order of specificity:
//
//  1. Bullet lines (^- foo bar.png$) whose content ends in a
//     recognized extension get the whole content wrapped.
//  2. Table rows (^| ... | filename | ... |$) — for each cell whose
//     trimmed content ends in a recognized extension, wrap that
//     cell's trimmed content in backticks. Handles multi-word
//     filenames in `ls`-style tables. ux-fixes round 2.
//  3. Everything else runs the token-level fileRefPattern regex
//     which catches paths and space-free filenames anywhere in prose.
//
// The passes don't conflict: bullets aren't tables aren't prose.
// After a multi-cell table row is wrapped, the token-level pass still
// runs on the same line (so a cell like "see /path/to/foo.go" with
// surrounding prose still picks up its space-free ref) and skips
// content inside the new backtick spans because fileRefPattern's
// boundary class doesn't include backticks.
func wrapFileRefsByLine(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if m := listBulletPattern.FindStringSubmatch(line); m != nil {
			prefix := m[1]
			content := m[2]
			if fileExtensionTailPattern.MatchString(content) {
				lines[i] = prefix + "`" + content + "`"
				continue
			}
		}
		// ux-fixes round 3 — skip ALL backtick wrapping on table rows.
		// The pre-round-3 wrapFileRefsInTableRow + token-pass combo
		// injected ANSI inline-code styling into table cells, which
		// then interleaved with lipgloss's cell-width-aware Render
		// in glamour's table layout. The result was reset-sequence
		// fragments leaking across cell boundaries — visually the
		// long-cell continuation row would render flush-left instead
		// of inside its cell column (ux3.png/ux4.png feedback). With
		// cells left un-backticked, lipgloss's table renderer keeps
		// cell content clean and the wrap stays inside the column.
		// File-ref styling on prose lines (including paragraphs that
		// SIT NEXT TO a table) is unaffected.
		if tableRowPattern.MatchString(line) {
			continue
		}
		// Token-level pass: catches single-token paths anywhere in
		// prose.
		lines[i] = fileRefPattern.ReplaceAllStringFunc(line, func(match string) string {
			subs := fileRefPattern.FindStringSubmatch(match)
			if len(subs) < 2 {
				return match
			}
			fileRef := subs[1]
			idx := strings.Index(match, fileRef)
			if idx < 0 {
				return match
			}
			return match[:idx] + "`" + fileRef + "`" + match[idx+len(fileRef):]
		})
	}
	return strings.Join(lines, "\n")
}

// wrapFileRefsInTableRow splits a markdown table row on `|` and
// wraps each cell whose trimmed content ends in a recognized file
// extension. Preserves leading/trailing whitespace inside each cell
// so the table's column alignment stays intact. Separator-row cells
// (only dashes, colons, and whitespace) are left alone.
//
// Returns the modified line. ux-fixes round 2.
func wrapFileRefsInTableRow(line string) string {
	parts := strings.Split(line, "|")
	for i, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" || tableSeparatorCellPattern.MatchString(trimmed) {
			continue
		}
		if !fileExtensionTailPattern.MatchString(trimmed) {
			continue
		}
		// Already inline-code-wrapped (e.g., a model that helpfully
		// pre-wrapped a single-token filename). Leave it alone.
		if strings.HasPrefix(trimmed, "`") && strings.HasSuffix(trimmed, "`") {
			continue
		}
		leadingWS := part[:len(part)-len(strings.TrimLeft(part, " \t"))]
		trailingWS := part[len(strings.TrimRight(part, " \t")):]
		parts[i] = leadingWS + "`" + trimmed + "`" + trailingWS
	}
	return strings.Join(parts, "|")
}

// styleForTheme builds a glamour StyleConfig that picks up the active
// theme's foreground / accent colors. Returning explicit hex codes (vs.
// ANSI 256 indices) keeps the rendered text consistent across terminals
// with different color-cube interpretations.
//
// M11.10 — body text (Document, Paragraph, Text, List items, Strong,
// Emph) intentionally does NOT set a Color so the terminal renders it
// with its default foreground. Repeated attempts to pick a "bright
// white" (Catppuccin Mocha text, slate-100, pure white via #ffffff,
// ANSI 15, ANSI 256-color index 231) all rendered DIMMER than the
// user's terminal default. The text-input cursor at the bottom uses
// no foreground style and renders as the brightest white the user's
// terminal can produce — so we follow the same approach for body
// text. Accent colors (headings, links, code-spans, code-blocks,
// errors) keep their theme.Primary / theme.Success / theme.Error
// styling because they need to be DIFFERENT from body text, not just
// bright.
func styleForTheme(t theme.Theme) ansi.StyleConfig {
	dim := string(t.Dim)
	primary := string(t.Primary)
	success := string(t.Success)
	error_ := string(t.Error)
	_ = t.CodeBackground // M11.11 — kept on the theme for future renderers; no longer applied here, see Code/CodeBlock comments below

	inlineCodeColor := style.S.Brand.AccentColor
	headingColor := style.S.Brand.HeadingColor

	// ux-fixes 2026-05-22 (ux4.png): drop the Document margin to 0.
	// Glamour v1.0.0's WithWordWrap value doesn't reliably account for
	// non-zero Document margins — at certain widths it produces orphan
	// single-word lines (e.g., at terminal width 115 the input
	// "...what the spec asked for..." rendered as "...the\nspec\nasked
	// for..."). With margin = 0 the wrap matches the available content
	// width exactly. The TUI doesn't need glamour's visual left-pad;
	// our scrollback flows from column 0 like every other line.
	margin := uint(0)
	listLevelIndent := uint(style.S.Markdown.ListLevelIndent)
	indent := uint(style.S.Markdown.BlockquoteIndent)
	listIndent := uint(style.S.Markdown.ListIndent)
	indentToken := style.S.Markdown.IndentToken

	bold := true
	italic := true

	return ansi.StyleConfig{
		Document: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				BlockPrefix: "\n",
				BlockSuffix: "\n",
				// No Color — inherit terminal default foreground.
			},
			Margin: &margin,
		},
		BlockQuote: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Color: &dim,
			},
			Indent:      &indent,
			IndentToken: &indentToken,
		},
		Paragraph: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				// No Color — inherit terminal default foreground.
			},
		},
		List: ansi.StyleList{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{
					// No Color — inherit terminal default foreground.
				},
				Indent: &listIndent,
			},
			LevelIndent: listLevelIndent,
		},
		Heading: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				BlockSuffix: "\n",
				Color:       &headingColor,
				Bold:        &bold,
			},
		},
		H1: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: style.S.Markdown.H1Prefix,
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H2: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: style.S.Markdown.H2Prefix,
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H3: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: style.S.Markdown.H3Prefix,
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H4: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: style.S.Markdown.H4Prefix,
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H5: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: style.S.Markdown.H5Prefix,
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H6: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: style.S.Markdown.H6Prefix,
				Color:  &headingColor,
			},
		},
		Text: ansi.StylePrimitive{
			// No Color — inherit terminal default foreground.
		},
		Strikethrough: ansi.StylePrimitive{
			CrossedOut: &bold,
		},
		Emph: ansi.StylePrimitive{
			Italic: &italic,
		},
		Strong: ansi.StylePrimitive{
			// 2026-05-28 — Strong now uses Brand.AccentColor (sky-300) to
			// match inline Code, unifying bold-emphasis treatment. Pre-
			// fix, bold `**56**` rendered uncolored while inline `Node.js`
			// rendered sky-blue — visually inconsistent across the same
			// "emphasized text" concept. Brand.AccentColor is a fixed hex
			// (not a theme token) so it survives palette quantization per
			// the brand-color rule in tui-color-rendering.md.
			Color: &inlineCodeColor,
			Bold:  &bold,
		},
		HorizontalRule: ansi.StylePrimitive{
			Color:  &dim,
			Format: "\n" + style.S.Markdown.HorizontalRule + "\n",
		},
		Item: ansi.StylePrimitive{
			BlockPrefix: style.S.Markdown.Bullet + " ",
			// No Color — inherit terminal default foreground.
		},
		Enumeration: ansi.StylePrimitive{
			BlockPrefix: ". ",
			// No Color — inherit terminal default foreground.
		},
		Task: ansi.StyleTask{
			StylePrimitive: ansi.StylePrimitive{
				// No Color — inherit terminal default foreground.
			},
			Ticked:   style.S.Markdown.TickedCheckbox,
			Unticked: style.S.Markdown.UntickedCheckbox,
		},
		Link: ansi.StylePrimitive{
			Color:     &primary,
			Underline: &bold,
		},
		LinkText: ansi.StylePrimitive{
			Color: &primary,
			Bold:  &bold,
		},
		Image: ansi.StylePrimitive{
			Color:     &primary,
			Underline: &bold,
		},
		ImageText: ansi.StylePrimitive{
			Color:  &primary,
			Format: "Image: {{.text}}",
		},
		Code: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				// M11.13 — inline code (backtick spans, typically file paths
				// in assistant responses) renders in a clear sky-blue bold
				// with NO background. Uses inlineCodeBlue (a fixed hex
				// brighter/lighter than theme.Primary) because theme.Primary's
				// #89b4fa rendered too dark/saturated on the user's terminal
				// palette — sky-blue #7dd3fc reads as the intended "light
				// blue" cue across more palettes.
				//
				// Background was dropped in M11.11 (dark hex backgrounds are
				// as unreliable as bright hex foregrounds — see
				// docs/conventions/tui-color-rendering.md).
				Color: &inlineCodeColor,
				Bold:  &bold,
			},
		},
		CodeBlock: ansi.StyleCodeBlock{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{
					// No Color — inherit terminal default foreground.
				},
				Margin: &margin,
			},
			Chroma: &ansi.Chroma{
				Text: ansi.StylePrimitive{
					// No Color — inherit terminal default foreground.
				},
				Error: ansi.StylePrimitive{
					Color: &error_,
				},
				Comment: ansi.StylePrimitive{
					Color: &dim,
				},
				CommentPreproc: ansi.StylePrimitive{
					Color: &dim,
				},
				Keyword: ansi.StylePrimitive{
					Color: &primary,
				},
				KeywordReserved: ansi.StylePrimitive{
					Color: &primary,
				},
				KeywordNamespace: ansi.StylePrimitive{
					Color: &primary,
				},
				KeywordType: ansi.StylePrimitive{
					Color: &primary,
				},
				Operator: ansi.StylePrimitive{
					// No Color — inherit terminal default foreground.
				},
				Punctuation: ansi.StylePrimitive{
					// No Color — inherit terminal default foreground.
				},
				Name: ansi.StylePrimitive{
					// No Color — inherit terminal default foreground.
				},
				NameBuiltin: ansi.StylePrimitive{
					Color: &primary,
				},
				NameTag: ansi.StylePrimitive{
					Color: &primary,
				},
				NameAttribute: ansi.StylePrimitive{
					Color: &success,
				},
				NameClass: ansi.StylePrimitive{
					Color:     &success,
					Underline: &bold,
					Bold:      &bold,
				},
				NameConstant: ansi.StylePrimitive{
					Color: &success,
				},
				NameDecorator: ansi.StylePrimitive{
					Color: &success,
				},
				NameFunction: ansi.StylePrimitive{
					Color: &success,
				},
				LiteralNumber: ansi.StylePrimitive{
					Color: &primary,
				},
				LiteralString: ansi.StylePrimitive{
					Color: &success,
				},
				LiteralStringEscape: ansi.StylePrimitive{
					Color: &primary,
				},
				GenericDeleted: ansi.StylePrimitive{
					Color: &error_,
				},
				GenericEmph: ansi.StylePrimitive{
					// No Color — italic alone distinguishes.
					Italic: &italic,
				},
				GenericInserted: ansi.StylePrimitive{
					Color: &success,
				},
				GenericStrong: ansi.StylePrimitive{
					// No Color — bold alone distinguishes.
					Bold: &bold,
				},
				GenericSubheading: ansi.StylePrimitive{
					Color: &primary,
				},
				Background: ansi.StylePrimitive{
					// M11.11 — no BackgroundColor; same reason as inline Code
					// above (dark hex backgrounds can render white on
					// terminals with inverted/non-standard palette mapping).
					// Fenced code blocks rely on the chroma syntax-highlight
					// colors for visual identity, not on a background fill.
				},
			},
		},
		Table: ansi.StyleTable{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{
					// No Color — inherit terminal default foreground.
				},
			},
			CenterSeparator: stringPtr("┼"),
			ColumnSeparator: stringPtr("│"),
			RowSeparator:    stringPtr("─"),
		},
		DefinitionDescription: ansi.StylePrimitive{
			BlockPrefix: "\n🠶 ",
			// No Color — inherit terminal default foreground.
		},
	}
}

func stringPtr(s string) *string { return &s }
