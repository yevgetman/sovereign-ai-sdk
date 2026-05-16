package theme

import "testing"

func TestSovereignFieldsPopulated(t *testing.T) {
	th := Sovereign()
	if th.Name != "sovereign" {
		t.Errorf("name: got %q want sovereign", th.Name)
	}
	if string(th.Background) != "#0d1117" {
		t.Errorf("background: got %q", th.Background)
	}
	if string(th.Primary) != "#58a6ff" {
		t.Errorf("primary: got %q", th.Primary)
	}
	if string(th.Foreground) == "" || string(th.Border) == "" {
		t.Error("foreground or border empty")
	}
}

func TestSovereignResolvable(t *testing.T) {
	th, ok := Resolve("sovereign")
	if !ok {
		t.Error("sovereign should resolve")
	}
	if th.Name != "sovereign" {
		t.Errorf("name: got %q", th.Name)
	}
}
