package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/transport"
)

func TestSkillMutationCatalogWarningReachesTranscript(t *testing.T) {
	for _, verb := range []string{"install", "import", "uninstall"} {
		for _, catalog := range []struct {
			name, value string
			warning     bool
		}{
			{"failed", `,"catalog":{"generation":3,"refreshed":false,"warning":"skill committed; catalog refresh failed; retry skills doctor refresh"}`, true},
			{"refreshed", `,"catalog":{"generation":4,"refreshed":true}`, false},
			{"legacy", "", false},
		} {
			t.Run(verb+"/"+catalog.name, func(t *testing.T) {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprintf(w, `{"ok":true,"name":"fresh","installedAt":"/store/fresh","removedFrom":"/store/fresh"%s}`, catalog.value)
				}))
				defer srv.Close()
				var message tea.Msg
				switch verb {
				case "install":
					result, err := transport.InstallSkill(context.Background(), srv.URL, "s-warning", "/source", false)
					if err != nil {
						t.Fatal(err)
					}
					message = skillInstalledMsg{result: result}
				case "import":
					result, err := transport.ImportSkill(context.Background(), srv.URL, "s-warning", "/source", false)
					if err != nil {
						t.Fatal(err)
					}
					message = skillImportedMsg{result: result}
				case "uninstall":
					result, err := transport.UninstallSkill(context.Background(), srv.URL, "s-warning", "fresh")
					if err != nil {
						t.Fatal(err)
					}
					message = skillUninstalledMsg{result: result}
				}
				m := New("s-warning", srv.URL)
				model, _ := m.Update(tea.WindowSizeMsg{Width: 180, Height: 24})
				m = model.(Model)
				model, _ = m.Update(message)
				m = model.(Model)
				m.drainPrintln()
				output := scrollbackContent(m)
				if !strings.Contains(output, "fresh") {
					t.Fatalf("committed result missing: %q", output)
				}
				hasWarning := strings.Contains(output, "catalog refresh failed")
				if hasWarning != catalog.warning {
					t.Fatalf("catalog warning=%t, want %t: %q", hasWarning, catalog.warning, output)
				}
				if catalog.warning && !strings.Contains(output, "/skills doctor refresh") {
					t.Fatalf("retry instruction missing: %q", output)
				}
				if strings.Contains(output, "failed: ") {
					t.Fatalf("committed mutation was reported as failed: %q", output)
				}
			})
		}
	}
}
