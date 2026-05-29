// Package style provides the global, immutable TUI style guide.
//
// The style guide owns every spacing, padding, margin, border, glyph,
// brand-color, and typography token in the TUI. It is orthogonal to the
// theme system: themes control switchable color palettes; the style
// guide controls structural layout. The two compose at render time.
//
// The package-level var S is the single source of truth. Components
// import this package and reference tokens directly (e.g.
// style.S.Card.PaddingH). S is initialized at package init and must
// never be mutated at runtime.
//
// Spec: docs/specs/2026-05-25-tui-style-guide-design.md
package style

import "github.com/charmbracelet/lipgloss"

// StyleGuide is the top-level container for all visual tokens.
type StyleGuide struct {
	Card        CardStyle
	CompactLine CompactLineStyle
	Delegator   DelegatorStyle
	Spinner     SpinnerStyle
	Prompt      PromptStyle
	Splash      SplashStyle
	Goodbye     GoodbyeStyle
	StatusLine  StatusLineStyle
	Picker      PickerStyle
	Permission  PermissionStyle
	Echo        EchoStyle
	Separator   SeparatorStyle
	Markdown    MarkdownStyle
	Diff        DiffStyle
	Glyph       GlyphTokens
	Brand       BrandColors
	Typography  TypographyStyle
}

// CardStyle governs the bordered-box pattern shared by 6+ components.
type CardStyle struct {
	PaddingV       int             // vertical padding (rows)
	PaddingH       int             // horizontal padding (cols)
	BorderOverhead int             // width reduction for left + right border
	Border         lipgloss.Border // border type

	GenerousPaddingV int // splash info card, goodbye card
	GenerousPaddingH int
}

// CompactLineStyle governs one-liner tool output rendering.
type CompactLineStyle struct {
	Indent            string // left margin indent
	Chevron           string // trailing affordance glyph
	PreviewMaxUnknown int    // truncation for unknown tool input
	PreviewMaxMCP     int    // truncation for MCP tool targets
	URLMax            int    // URL truncation limit
}

// DelegatorStyle governs routing event line rendering.
type DelegatorStyle struct {
	Indent string // left margin (matches CompactLine)
}

// SpinnerStyle governs the thinking indicator animation.
type SpinnerStyle struct {
	DotCycleStride   int    // frames between dot-count changes
	ColorCycleStride int    // frames per gradient color advance
	GlyphSpacing     string // gap between glyph and label
}

// PromptStyle governs the text input box.
type PromptStyle struct {
	MaxHeight            int // max visible textarea rows
	PasteAbstractMinLines int // threshold for paste abstraction (lines)
	PasteAbstractMinChars int // secondary paste threshold (chars)
	BoxOverhead          int // border (2) + padding (2)
	PromptWidth          int // marker prefix width (visible columns)
	Marker               string // textarea first-line prefix; visually distinct from Echo.Marker
}

// SplashStyle governs the boot splash screen.
type SplashStyle struct {
	Gutter       int // space between logo and info card
	SafetyMargin int // minimum margin for fallback mode
}

// GoodbyeStyle governs the session-end card.
type GoodbyeStyle struct {
	WidthNumerator   int // cardWidth = width * Numerator / Denominator
	WidthDenominator int
	LabelPad         int // label column width
	AgentPad         int // agent name column width
}

// StatusLineStyle governs the bottom status bar.
type StatusLineStyle struct {
	FieldSeparator string // between cwd, profile, model, cost
	EdgeMargin     string // left/right edge padding
}

// PickerStyle governs the picker card dropdown.
type PickerStyle struct {
	ValueGap         int    // columns between label and value
	SelectedPrefix   string // selected row prefix
	UnselectedPrefix string // unselected row prefix
}

// PermissionStyle governs the permission prompt.
type PermissionStyle struct {
	PreviewMax int // max preview chars before truncation
	PaddingH   int // horizontal padding (wider than Card)
	LabelWidth int // fixed-width label column
}

// EchoStyle governs the user echo marker.
type EchoStyle struct {
	Marker      string // "❯ " prefix
	MarkerWidth int    // numeric width for wrap calculation
	LeadingGap  int    // blank lines before the echo (breathing room above user turn)
	TrailingGap int    // blank lines after the echo before the next event
}

// SeparatorStyle governs the turn separator.
type SeparatorStyle struct {
	Char        string // horizontal rule character
	TrailingGap int    // blank lines after the separator (end-of-turn breathing room)
}

// MarkdownStyle governs markdown rendering tokens.
type MarkdownStyle struct {
	ListLevelIndent  int    // indent per nesting level
	BlockquoteIndent int    // blockquote indent
	ListIndent       int    // list item indent
	IndentToken      string // blockquote marker
	Bullet           string // list bullet character
	HorizontalRule   string // horizontal rule string

	TickedCheckbox   string
	UntickedCheckbox string

	H1Prefix string
	H2Prefix string
	H3Prefix string
	H4Prefix string
	H5Prefix string
	H6Prefix string
}

// DiffStyle governs diff rendering prefixes.
type DiffStyle struct {
	AddedPrefix   string
	RemovedPrefix string
	ContextPrefix string
	HunkMarker    string
}

// GlyphTokens holds shared status indicator characters.
type GlyphTokens struct {
	Success string // tool/atom success
	Error   string // tool/atom failure
	Warning string // permission denied, stall badge
	Plan    string // delegator plan start
	Done    string // delegator complete
	Arrow   string // atom dispatch
}

// BrandColors holds fixed hex colors that do NOT change with themes.
// These are pinned because the specific shade family must survive
// palette mapping across all terminals. See
// docs/conventions/tui-color-rendering.md for the rationale.
type BrandColors struct {
	VerbColor         string // purple for tool verbs + tool card header
	AccentColor       string // sky-300 for delegator accents + inline code
	HeadingColor      string // sky-100 for markdown headings (one step lighter than sky-300 emphasis)
	PickerItemColor   string // peach for picker/autocomplete items
	PickerHintColor   string // grey-blue for hints
	PickerBadgeColor  string // green for "live" badge
	PromptBorderColor string // Catppuccin overlay1 for prompt border
	PermissionYellow  string // permission prompt yellow
	PermissionGrey    string // permission prompt grey

	LogoGradient    [6]string // splash gradient (blue→teal→purple→pink)
	SpinnerGradient [4]string // compressed 4-anchor version
}

// TypographyStyle holds text style presets that compose with Theme
// colors at render time.
type TypographyStyle struct {
	TitleBold     bool // titles: Bold(true), no Foreground
	HintItalic    bool // hints: Italic(true), uses theme.Dim
	SelectedBold  bool // selected items: Bold(true), no Foreground
	LinkUnderline bool // links: Underline(true) + Bold(true)
}

// S is the global, immutable style guide. All values are seeded from
// the exact constants used by each component at the time the style
// guide was introduced — visual output is byte-identical.
var S = StyleGuide{
	Card: CardStyle{
		PaddingV:         0,
		PaddingH:         1,
		BorderOverhead:   2,
		Border:           lipgloss.RoundedBorder(),
		GenerousPaddingV: 1,
		GenerousPaddingH: 2,
	},
	CompactLine: CompactLineStyle{
		Indent:            "  ",
		Chevron:           "›",
		PreviewMaxUnknown: 40,
		PreviewMaxMCP:     32,
		URLMax:            60,
	},
	Delegator: DelegatorStyle{
		Indent: "  ",
	},
	Spinner: SpinnerStyle{
		DotCycleStride:   5,
		ColorCycleStride: 3,
		GlyphSpacing:     "  ",
	},
	Prompt: PromptStyle{
		MaxHeight:             8,
		PasteAbstractMinLines: 2,
		PasteAbstractMinChars: 200,
		BoxOverhead:           4,
		PromptWidth:           2,
		Marker:                "▸ ",
	},
	Splash: SplashStyle{
		Gutter:       2,
		SafetyMargin: 2,
	},
	Goodbye: GoodbyeStyle{
		WidthNumerator:   3,
		WidthDenominator: 5,
		LabelPad:         11,
		AgentPad:         18,
	},
	StatusLine: StatusLineStyle{
		FieldSeparator: "  ",
		EdgeMargin:     " ",
	},
	Picker: PickerStyle{
		ValueGap:         3,
		SelectedPrefix:   "› ",
		UnselectedPrefix: "  ",
	},
	Permission: PermissionStyle{
		PreviewMax: 60,
		PaddingH:   2,
		LabelWidth: 7,
	},
	Echo: EchoStyle{
		Marker:      "❯ ",
		MarkerWidth: 2,
		LeadingGap:  1,
		TrailingGap: 1,
	},
	Separator: SeparatorStyle{
		Char:        "─",
		TrailingGap: 0,
	},
	Markdown: MarkdownStyle{
		ListLevelIndent:  4,
		BlockquoteIndent: 1,
		ListIndent:       2,
		IndentToken:      "│ ",
		Bullet:           "•",
		HorizontalRule:   "────────",
		TickedCheckbox:   "[✓] ",
		UntickedCheckbox: "[ ] ",
		H1Prefix:         "# ",
		H2Prefix:         "## ",
		H3Prefix:         "### ",
		H4Prefix:         "#### ",
		H5Prefix:         "##### ",
		H6Prefix:         "###### ",
	},
	Diff: DiffStyle{
		AddedPrefix:   "+ ",
		RemovedPrefix: "- ",
		ContextPrefix: "  ",
		HunkMarker:    "▶ ",
	},
	Glyph: GlyphTokens{
		Success: "✓",
		Error:   "✗",
		Warning: "⚠",
		Plan:    "◇",
		Done:    "◆",
		Arrow:   "→",
	},
	Brand: BrandColors{
		VerbColor:         "#a78bfa",
		AccentColor:       "#7dd3fc",
		HeadingColor:      "#e0f2fe",
		PickerItemColor:   "#fab387",
		PickerHintColor:   "#7a8eb8",
		PickerBadgeColor:  "#a6e3a1",
		PromptBorderColor: "#6c7086",
		PermissionYellow:  "#e5c07b",
		PermissionGrey:    "#6e7681",
		LogoGradient: [6]string{
			"#4f8fff", "#22d3ee", "#14b8a6",
			"#a78bfa", "#d946ef", "#ec4899",
		},
		SpinnerGradient: [4]string{
			"#4f8fff", "#22d3ee", "#a78bfa", "#ec4899",
		},
	},
	Typography: TypographyStyle{
		TitleBold:     true,
		HintItalic:    true,
		SelectedBold:  true,
		LinkUnderline: true,
	},
}
