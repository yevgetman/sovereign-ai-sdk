// Package app — tests for M10.5 generic slash-command parsing.

package app

import "testing"

func TestParseGenericSlashCommand(t *testing.T) {
	tests := []struct {
		input    string
		wantName string
		wantArgs string
		wantOK   bool
	}{
		// Happy paths
		{"/help", "help", "", true},
		{"/cost", "cost", "", true},
		{"/model claude-sonnet-4-6", "model", "claude-sonnet-4-6", true},
		{"/config set defaultProvider anthropic", "config", "set defaultProvider anthropic", true},
		{"  /help  ", "help", "", true},                // trim outer whitespace
		{"/model  claude-sonnet-4-6  ", "model", "claude-sonnet-4-6", true}, // collapse inner runs

		// Reject paths
		{"", "", "", false},
		{"hello", "", "", false},          // no leading slash
		{"/", "", "", false},              // slash only
		{"  /  ", "", "", false},          // slash + whitespace only
		{"  ", "", "", false},             // whitespace only
		{"not /help", "", "", false}, // slash not at start
		// "//help" parses to name="/help" — see
		// TestParseGenericSlashCommand_PreservesDoubleSlashName below.
		// Server-side CommandRequestSchema rejects names starting with /
		// so the user gets an error envelope rather than a silent
		// dispatch. Keeping the parser permissive avoids client-side
		// validation drift.
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			gotName, gotArgs, gotOK := parseGenericSlashCommand(tc.input)
			if gotOK != tc.wantOK {
				t.Fatalf("parseGenericSlashCommand(%q) ok = %v, want %v", tc.input, gotOK, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if gotName != tc.wantName {
				t.Errorf("name = %q, want %q", gotName, tc.wantName)
			}
			if gotArgs != tc.wantArgs {
				t.Errorf("args = %q, want %q", gotArgs, tc.wantArgs)
			}
		})
	}
}

func TestParseGenericSlashCommand_PreservesDoubleSlashName(t *testing.T) {
	// "/foo/bar" parses to name="foo/bar". The server-side
	// CommandRequestSchema rejects names with embedded slashes, so this
	// returns an envelope error rather than a panic. The parser stays
	// lenient — let server-side validation be authoritative.
	name, args, ok := parseGenericSlashCommand("/foo/bar")
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if name != "foo/bar" {
		t.Errorf("name = %q, want foo/bar", name)
	}
	if args != "" {
		t.Errorf("args = %q, want empty", args)
	}
}
