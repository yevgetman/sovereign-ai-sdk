package style

import (
	"reflect"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// intentionallyZero lists fields that are 0 by design.
var intentionallyZero = map[string]bool{
	"S.Card.PaddingV": true,
}

func TestAllFieldsNonZero(t *testing.T) {
	checkNonZero(t, reflect.ValueOf(S), "S")
}

func checkNonZero(t *testing.T, v reflect.Value, path string) {
	t.Helper()
	switch v.Kind() {
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			field := v.Type().Field(i)
			checkNonZero(t, v.Field(i), path+"."+field.Name)
		}
	case reflect.Array:
		for i := 0; i < v.Len(); i++ {
			if v.Index(i).IsZero() {
				t.Errorf("%s[%d] is zero", path, i)
			}
		}
	default:
		if v.IsZero() && !intentionallyZero[path] {
			t.Errorf("%s is zero", path)
		}
	}
}

func TestKnownValues(t *testing.T) {
	tests := []struct {
		name string
		got  any
		want any
	}{
		// Card
		{"Card.PaddingV", S.Card.PaddingV, 0},
		{"Card.PaddingH", S.Card.PaddingH, 1},
		{"Card.BorderOverhead", S.Card.BorderOverhead, 2},
		{"Card.GenerousPaddingV", S.Card.GenerousPaddingV, 1},
		{"Card.GenerousPaddingH", S.Card.GenerousPaddingH, 2},

		// CompactLine
		{"CompactLine.Indent", S.CompactLine.Indent, "  "},
		{"CompactLine.Chevron", S.CompactLine.Chevron, "›"},
		{"CompactLine.PreviewMaxUnknown", S.CompactLine.PreviewMaxUnknown, 40},
		{"CompactLine.PreviewMaxMCP", S.CompactLine.PreviewMaxMCP, 32},
		{"CompactLine.URLMax", S.CompactLine.URLMax, 60},

		// Delegator
		{"Delegator.Indent", S.Delegator.Indent, "  "},

		// Spinner
		{"Spinner.DotCycleStride", S.Spinner.DotCycleStride, 5},
		{"Spinner.ColorCycleStride", S.Spinner.ColorCycleStride, 3},
		{"Spinner.GlyphSpacing", S.Spinner.GlyphSpacing, "  "},

		// Prompt
		{"Prompt.MaxHeight", S.Prompt.MaxHeight, 8},
		{"Prompt.PasteAbstractMinLines", S.Prompt.PasteAbstractMinLines, 2},
		{"Prompt.PasteAbstractMinChars", S.Prompt.PasteAbstractMinChars, 200},
		{"Prompt.BoxOverhead", S.Prompt.BoxOverhead, 4},
		{"Prompt.PromptWidth", S.Prompt.PromptWidth, 2},

		// Splash
		{"Splash.Gutter", S.Splash.Gutter, 2},
		{"Splash.SafetyMargin", S.Splash.SafetyMargin, 2},

		// Goodbye
		{"Goodbye.WidthNumerator", S.Goodbye.WidthNumerator, 3},
		{"Goodbye.WidthDenominator", S.Goodbye.WidthDenominator, 5},
		{"Goodbye.LabelPad", S.Goodbye.LabelPad, 11},
		{"Goodbye.AgentPad", S.Goodbye.AgentPad, 18},

		// StatusLine
		{"StatusLine.FieldSeparator", S.StatusLine.FieldSeparator, "  "},
		{"StatusLine.EdgeMargin", S.StatusLine.EdgeMargin, " "},

		// Picker
		{"Picker.ValueGap", S.Picker.ValueGap, 3},
		{"Picker.SelectedPrefix", S.Picker.SelectedPrefix, "› "},
		{"Picker.UnselectedPrefix", S.Picker.UnselectedPrefix, "  "},

		// Permission
		{"Permission.PreviewMax", S.Permission.PreviewMax, 60},
		{"Permission.PaddingH", S.Permission.PaddingH, 2},
		{"Permission.LabelWidth", S.Permission.LabelWidth, 7},

		// Echo
		{"Echo.Marker", S.Echo.Marker, "» "},
		{"Echo.MarkerWidth", S.Echo.MarkerWidth, 2},

		// Separator
		{"Separator.Char", S.Separator.Char, "─"},

		// Glyphs
		{"Glyph.Success", S.Glyph.Success, "✓"},
		{"Glyph.Error", S.Glyph.Error, "✗"},
		{"Glyph.Warning", S.Glyph.Warning, "⚠"},
		{"Glyph.Plan", S.Glyph.Plan, "◇"},
		{"Glyph.Done", S.Glyph.Done, "◆"},
		{"Glyph.Arrow", S.Glyph.Arrow, "→"},

		// Brand
		{"Brand.VerbColor", S.Brand.VerbColor, "#a78bfa"},
		{"Brand.AccentColor", S.Brand.AccentColor, "#7dd3fc"},
		{"Brand.HeadingColor", S.Brand.HeadingColor, "#bae6fd"},
		{"Brand.PickerItemColor", S.Brand.PickerItemColor, "#fab387"},
		{"Brand.PickerHintColor", S.Brand.PickerHintColor, "#7a8eb8"},
		{"Brand.PickerBadgeColor", S.Brand.PickerBadgeColor, "#a6e3a1"},
		{"Brand.PromptBorderColor", S.Brand.PromptBorderColor, "#6c7086"},
		{"Brand.PermissionYellow", S.Brand.PermissionYellow, "#e5c07b"},
		{"Brand.PermissionGrey", S.Brand.PermissionGrey, "#6e7681"},

		// Typography
		{"Typography.TitleBold", S.Typography.TitleBold, true},
		{"Typography.HintItalic", S.Typography.HintItalic, true},
		{"Typography.SelectedBold", S.Typography.SelectedBold, true},
		{"Typography.LinkUnderline", S.Typography.LinkUnderline, true},

		// Markdown
		{"Markdown.ListLevelIndent", S.Markdown.ListLevelIndent, 4},
		{"Markdown.BlockquoteIndent", S.Markdown.BlockquoteIndent, 1},
		{"Markdown.ListIndent", S.Markdown.ListIndent, 2},
		{"Markdown.IndentToken", S.Markdown.IndentToken, "│ "},
		{"Markdown.Bullet", S.Markdown.Bullet, "•"},
		{"Markdown.HorizontalRule", S.Markdown.HorizontalRule, "────────"},
		{"Markdown.TickedCheckbox", S.Markdown.TickedCheckbox, "[✓] "},
		{"Markdown.UntickedCheckbox", S.Markdown.UntickedCheckbox, "[ ] "},
		{"Markdown.H1Prefix", S.Markdown.H1Prefix, "# "},
		{"Markdown.H6Prefix", S.Markdown.H6Prefix, "###### "},

		// Diff
		{"Diff.AddedPrefix", S.Diff.AddedPrefix, "+ "},
		{"Diff.RemovedPrefix", S.Diff.RemovedPrefix, "- "},
		{"Diff.ContextPrefix", S.Diff.ContextPrefix, "  "},
		{"Diff.HunkMarker", S.Diff.HunkMarker, "▶ "},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !reflect.DeepEqual(tt.got, tt.want) {
				t.Errorf("got %v, want %v", tt.got, tt.want)
			}
		})
	}
}

func TestCardBorderIsRounded(t *testing.T) {
	if S.Card.Border != lipgloss.RoundedBorder() {
		t.Error("Card.Border should be lipgloss.RoundedBorder()")
	}
}

func TestImmutability(t *testing.T) {
	snapshot := S
	if !reflect.DeepEqual(snapshot, S) {
		t.Error("style.S was mutated between snapshot and check")
	}
}

func TestLogoGradientLength(t *testing.T) {
	if len(S.Brand.LogoGradient) != 6 {
		t.Errorf("LogoGradient: got %d colors, want 6", len(S.Brand.LogoGradient))
	}
}

func TestSpinnerGradientLength(t *testing.T) {
	if len(S.Brand.SpinnerGradient) != 4 {
		t.Errorf("SpinnerGradient: got %d colors, want 4", len(S.Brand.SpinnerGradient))
	}
}
