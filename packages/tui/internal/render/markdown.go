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
	return out
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
// surrounding prose. Extension list covers what models typically
// mention in agent responses; not exhaustive but conservative.
var fileRefPattern = regexp.MustCompile(
	`(?:^|[\s(\[{"'])((?:/|~/|\./|\.\./)[\w./\-]+|[\w\-][\w\-.]*\.(?:png|jpe?g|gif|svg|webp|ico|md|mdx|txt|json|ya?ml|toml|csv|tsv|log|go|ts|tsx|js|jsx|mjs|cjs|py|rs|sh|bash|zsh|fish|html?|css|scss|sass|sql|c|cc|cpp|cxx|h|hpp|java|kt|rb|php|swift|mm?|xml|conf|cfg|ini|env|lock|gitignore|gitattributes|dockerfile|makefile))(?:$|[\s),.!?:;\]}"'])`,
)

// fileExtensionTailPattern matches the trailing portion of a string that
// looks like a known file extension. Used to confirm a markdown list
// item's content is a filename (multi-word filenames need to be
// recognized as a unit, since fileRefPattern is constrained to
// space-free tokens).
var fileExtensionTailPattern = regexp.MustCompile(
	`\.(?:png|jpe?g|gif|svg|webp|ico|md|mdx|txt|json|ya?ml|toml|csv|tsv|log|go|ts|tsx|js|jsx|mjs|cjs|py|rs|sh|bash|zsh|fish|html?|css|scss|sass|sql|c|cc|cpp|cxx|h|hpp|java|kt|rb|php|swift|mm?|xml|conf|cfg|ini|env|lock|gitignore|gitattributes|dockerfile|makefile)$`,
)

// listBulletPattern matches a markdown list-item prefix:
// optional indent, then "- " or "* " or "+ ".
var listBulletPattern = regexp.MustCompile(`^(\s*[-*+]\s+)(.*)$`)

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
// Bullet lines whose content ends in a recognized extension get the
// whole content (spaces and all) wrapped. Non-bullet lines run the
// token-level regex.
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
		// Fall through: run token-level regex.
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

	// M11.13 — inline-code accent color, picked specifically for "light
	// blue file path" readability. Lighter than theme.Primary's
	// #89b4fa which rendered too dark on the user's terminal.
	// #7dd3fc is Tailwind's sky-300 — a clean, recognizable light
	// sky-blue. Bound to a local var so we can take its address for
	// the StylePrimitive.Color field below.
	inlineCodeColor := "#7dd3fc"

	// ux-fixes — markdown section headers (H1–H6) pin to a fixed
	// light-blue hex rather than theme.Primary. The user reported
	// theme.Primary (Catppuccin blue #89b4fa / Sovereign #58a6ff)
	// rendered too dark/saturated for "## Heading" style structural
	// markers. #bae6fd is Tailwind's sky-200 — one shade lighter than
	// the inline-code sky-300 so headers and inline-code spans read
	// as distinct visual elements while sharing the same "light sky
	// blue" family. Pinning to a fixed hex (per
	// docs/conventions/tui-color-rendering.md) ensures the chosen
	// shade survives palette mapping across terminals and themes.
	headingColor := "#bae6fd"

	margin := uint(2)
	listLevelIndent := uint(4)
	indent := uint(1)
	indentToken := "│ "
	bullet := "•"

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
				Prefix: "# ",
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H2: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "## ",
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H3: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "### ",
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H4: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "#### ",
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H5: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "##### ",
				Color:  &headingColor,
				Bold:   &bold,
			},
		},
		H6: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "###### ",
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
			// No Color — inherit terminal default; Bold is enough to
			// visually distinguish strong text from body.
			Bold: &bold,
		},
		HorizontalRule: ansi.StylePrimitive{
			Color:  &dim,
			Format: "\n────────\n",
		},
		Item: ansi.StylePrimitive{
			BlockPrefix: bullet + " ",
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
			Ticked:   "[✓] ",
			Unticked: "[ ] ",
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
