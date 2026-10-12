package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
)

func TestSkillsDoctorReachesServerCommand(t *testing.T) {
	requests := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/commands") {
			if r.Method == http.MethodPost {
				var body struct {
					Name string `json:"name"`
					Args string `json:"args"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body.Name + " " + body.Args
				fmt.Fprint(w, `{"output":"skill generation 2: 3 loaded"}`)
			} else {
				fmt.Fprint(w, `{"commands":[]}`)
			}
			return
		}
		if strings.HasSuffix(r.URL.Path, "/skills") {
			fmt.Fprint(w, `{"skills":[]}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/messages") {
			fmt.Fprint(w, `{"messages":[]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	defer srv.Close()
	tm := teatest.NewTestModel(t, New("s-doctor", srv.URL), teatest.WithInitialTermSize(80, 24))
	tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/skills doctor --json")})
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	select {
	case value := <-requests:
		if value != "skills doctor --json" {
			t.Fatalf("forwarded %q", value)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("doctor did not reach server")
	}
	tm.Send(tea.KeyMsg{Type: tea.KeyCtrlC})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}
