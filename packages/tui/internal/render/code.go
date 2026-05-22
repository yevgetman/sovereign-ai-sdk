package render

import (
	"strings"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/theme"
)

// Code renders a code block with chroma syntax highlighting. language is the
// fence info string (e.g., "go", "ts", "python"). Empty language → Plain.
// Falls back to Plain on any chroma error.
func Code(text, language string, t theme.Theme, width int) string {
	if text == "" {
		return ""
	}
	if language == "" {
		return Plain(text, t, width)
	}
	lexer := lexers.Get(language)
	if lexer == nil {
		return Plain(text, t, width)
	}
	style := chromaStyleForTheme(t)
	formatter := formatters.Get("terminal16m")
	if formatter == nil {
		return Plain(text, t, width)
	}
	iter, err := lexer.Tokenise(nil, text)
	if err != nil {
		return Plain(text, t, width)
	}
	var sb strings.Builder
	if err := formatter.Format(&sb, style, iter); err != nil {
		return Plain(text, t, width)
	}
	return sb.String()
}

// chromaStyleForTheme picks the chroma style closest to the theme. Falls
// back to a bundled neutral if the preferred style isn't compiled into
// the chroma binary.
//
// ux-fixes 2026-05-22: switched the dark-theme preferred style from
// catppuccin-mocha to monokai. The Catppuccin palette is intentionally
// soft + low-contrast and was being further quantized by the user's
// terminal palette mapping — fenced code blocks rendered as flat dim
// text with no visible syntax-token differentiation. Monokai's
// high-contrast color scheme survives palette mapping more reliably,
// per the same lessons documented in tui-color-rendering.md (M11.7's
// TrueColor-force regression). catppuccin-mocha remains as last-ditch
// fallback for the rare chroma builds that don't bundle monokai.
func chromaStyleForTheme(t theme.Theme) *chroma.Style {
	if t.Name == "light" {
		if s := styles.Get("catppuccin-latte"); s != nil && s.Name != "swapoff" {
			return s
		}
		return styles.Get("github")
	}
	if s := styles.Get("monokai"); s != nil && s.Name != "swapoff" {
		return s
	}
	return styles.Get("catppuccin-mocha")
}
