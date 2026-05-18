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
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/ansi"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// Markdown renders Github-flavored markdown via glamour. Falls back to
// Plain on any glamour error so the TUI never crashes on garbage input
// from the model. Width is the wrap column (glamour's WordWrap).
//
// M11.1 — uses a theme-driven custom StyleConfig so body text picks up
// theme.Foreground (e.g., Catppuccin Mocha #cdd6f4) instead of glamour's
// default ANSI 256 "252" which renders as dark grey on terminals with
// non-standard color cubes. This was the dominant readability complaint
// after the M11 default-flip; users saw model responses as illegible
// dark text on a dark background.
func Markdown(text string, t theme.Theme, width int) string {
	if text == "" {
		return ""
	}
	if width <= 0 {
		return text
	}
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
				Color:       &primary,
				Bold:        &bold,
			},
		},
		H1: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "# ",
				Color:  &primary,
				Bold:   &bold,
			},
		},
		H2: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "## ",
				Color:  &primary,
				Bold:   &bold,
			},
		},
		H3: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "### ",
				Color:  &primary,
				Bold:   &bold,
			},
		},
		H4: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "#### ",
				Color:  &primary,
				Bold:   &bold,
			},
		},
		H5: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "##### ",
				Color:  &primary,
				Bold:   &bold,
			},
		},
		H6: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "###### ",
				Color:  &primary,
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
				// M11.11 — inline code (backtick spans, typically file paths
				// in assistant responses) renders in light-blue bold with NO
				// background. The previous BackgroundColor: &codeBg (Catppuccin
				// mantle #181825 — meant to be a dark code-block fill) rendered
				// as a near-white strip on terminals where palette mapping
				// inverts dark hexes. Same root-cause family as the body-text
				// rule in docs/conventions/tui-color-rendering.md: dark hex
				// backgrounds are as unreliable as bright hex foregrounds.
				// Light-blue (theme.Primary) + Bold gives a clear "this is
				// code" signal without a background to misrender.
				Color: &primary,
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
