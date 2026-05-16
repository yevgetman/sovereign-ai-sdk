package theme

import "testing"

func TestTokyoNightFieldsPopulated(t *testing.T) {
	th := TokyoNight()
	if th.Name != "tokyo-night" {
		t.Errorf("name: got %q want tokyo-night", th.Name)
	}
	if string(th.Background) != "#1a1b26" {
		t.Errorf("background: got %q", th.Background)
	}
	if string(th.Primary) != "#7aa2f7" {
		t.Errorf("primary: got %q", th.Primary)
	}
	if string(th.Foreground) == "" || string(th.Border) == "" {
		t.Error("foreground or border empty")
	}
}

func TestTokyoNightResolvable(t *testing.T) {
	th, ok := Resolve("tokyo-night")
	if !ok {
		t.Error("tokyo-night should resolve")
	}
	if th.Name != "tokyo-night" {
		t.Errorf("name: got %q", th.Name)
	}
}
