package theme

import "testing"

func TestDarkPaletteFieldsPopulated(t *testing.T) {
	d := Dark()
	if d.Name != "dark" {
		t.Errorf("name: got %q want dark", d.Name)
	}
	if string(d.Background) == "" || string(d.Foreground) == "" {
		t.Error("dark palette has empty background or foreground")
	}
	if string(d.Primary) == "" || string(d.Error) == "" {
		t.Error("dark palette has empty primary or error")
	}
}

func TestLightPaletteFieldsPopulated(t *testing.T) {
	l := Light()
	if l.Name != "light" {
		t.Errorf("name: got %q want light", l.Name)
	}
	if string(l.Background) == "" || string(l.Foreground) == "" {
		t.Error("light palette has empty background or foreground")
	}
}

func TestResolveKnownNames(t *testing.T) {
	d, ok := Resolve("dark")
	if !ok || d.Name != "dark" {
		t.Errorf("Resolve(dark): got (%v, %v) want (dark, true)", d.Name, ok)
	}
	l, ok := Resolve("light")
	if !ok || l.Name != "light" {
		t.Errorf("Resolve(light): got (%v, %v) want (light, true)", l.Name, ok)
	}
}

func TestResolveUnknownNameFallsBackToDarkWithFalse(t *testing.T) {
	got, ok := Resolve("eldritch-purple")
	if ok {
		t.Error("Resolve(unknown): ok should be false")
	}
	if got.Name != "dark" {
		t.Errorf("Resolve(unknown).Name: got %q want dark (fallback)", got.Name)
	}
}

func TestHeaderStylePreservesContent(t *testing.T) {
	d := Dark()
	s := d.HeaderStyle().Render("hi")
	// In a non-TTY test environment lipgloss strips color codes, so we
	// can't assert ANSI escapes. We do assert the content is preserved.
	if !contains(s, "hi") {
		t.Errorf("HeaderStyle dropped content: %q", s)
	}
}

func TestDimStylePreservesContent(t *testing.T) {
	d := Dark()
	s := d.DimStyle().Render("hi")
	if !contains(s, "hi") {
		t.Errorf("DimStyle dropped content: %q", s)
	}
}

func TestCardBorderStyleAddsBorder(t *testing.T) {
	d := Dark()
	s := d.CardBorderStyle().Render("hi")
	// Border-styled output is always multi-line (border on top/bottom).
	if !contains(s, "hi") {
		t.Errorf("CardBorderStyle dropped content: %q", s)
	}
	if !contains(s, "\n") {
		t.Errorf("CardBorderStyle should produce multi-line output: %q", s)
	}
}

func TestStatusBarStylePreservesContent(t *testing.T) {
	d := Dark()
	s := d.StatusBarStyle().Render("hi")
	if !contains(s, "hi") {
		t.Errorf("StatusBarStyle dropped content: %q", s)
	}
}

func TestErrorStylePreservesContent(t *testing.T) {
	d := Dark()
	s := d.ErrorStyle().Render("hi")
	if !contains(s, "hi") {
		t.Errorf("ErrorStyle dropped content: %q", s)
	}
}

// contains is a local helper to avoid importing strings just for this.
func contains(s, sub string) bool {
	if sub == "" {
		return true
	}
	if len(sub) > len(s) {
		return false
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
