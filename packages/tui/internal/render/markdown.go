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
// M11.5 — assistant body text uses a brighter foreground hex than the
// raw theme.Foreground when the active theme is dark. Catppuccin's
// #cdd6f4 (Mocha text) reads as dim grey against many terminal
// backgrounds; bumping to #e2e8f0 (a cool off-white) keeps responses
// clearly legible without sacrificing the theme aesthetic. Light themes
// retain their original foreground since making it brighter would
// reduce contrast against the light background.
func styleForTheme(t theme.Theme) ansi.StyleConfig {
	fg := assistantBodyFg(t)
	dim := string(t.Dim)
	primary := string(t.Primary)
	success := string(t.Success)
	error_ := string(t.Error)
	codeBg := string(t.CodeBackground)

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
				Color:       &fg,
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
				Color: &fg,
			},
		},
		List: ansi.StyleList{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{
					Color: &fg,
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
			Color: &fg,
		},
		Strikethrough: ansi.StylePrimitive{
			CrossedOut: &bold,
		},
		Emph: ansi.StylePrimitive{
			Color:  &fg,
			Italic: &italic,
		},
		Strong: ansi.StylePrimitive{
			Color: &fg,
			Bold:  &bold,
		},
		HorizontalRule: ansi.StylePrimitive{
			Color:  &dim,
			Format: "\n────────\n",
		},
		Item: ansi.StylePrimitive{
			BlockPrefix: bullet + " ",
			Color:       &fg,
		},
		Enumeration: ansi.StylePrimitive{
			BlockPrefix: ". ",
			Color:       &fg,
		},
		Task: ansi.StyleTask{
			StylePrimitive: ansi.StylePrimitive{
				Color: &fg,
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
				Prefix:          " ",
				Suffix:          " ",
				Color:           &success,
				BackgroundColor: &codeBg,
			},
		},
		CodeBlock: ansi.StyleCodeBlock{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{
					Color: &fg,
				},
				Margin: &margin,
			},
			Chroma: &ansi.Chroma{
				Text: ansi.StylePrimitive{
					Color: &fg,
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
					Color: &fg,
				},
				Punctuation: ansi.StylePrimitive{
					Color: &fg,
				},
				Name: ansi.StylePrimitive{
					Color: &fg,
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
					Color:  &fg,
					Italic: &italic,
				},
				GenericInserted: ansi.StylePrimitive{
					Color: &success,
				},
				GenericStrong: ansi.StylePrimitive{
					Color: &fg,
					Bold:  &bold,
				},
				GenericSubheading: ansi.StylePrimitive{
					Color: &primary,
				},
				Background: ansi.StylePrimitive{
					BackgroundColor: &codeBg,
				},
			},
		},
		Table: ansi.StyleTable{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{
					Color: &fg,
				},
			},
			CenterSeparator: stringPtr("┼"),
			ColumnSeparator: stringPtr("│"),
			RowSeparator:    stringPtr("─"),
		},
		DefinitionDescription: ansi.StylePrimitive{
			BlockPrefix: "\n🠶 ",
			Color:       &fg,
		},
	}
}

func stringPtr(s string) *string { return &s }

// assistantBodyFg returns the foreground hex used for assistant-body
// text in the markdown renderer. Dark themes get bumped to a brighter
// near-white (#f1f5f9 — Slate 100) for legibility; light themes keep
// their theme.Foreground so contrast against a light background stays
// correct. M11.6 bumped from #e2e8f0 because the previous value
// still read as dim grey on some terminal palettes.
func assistantBodyFg(t theme.Theme) string {
	if t.Name == "light" {
		return string(t.Foreground)
	}
	return "#f1f5f9"
}
