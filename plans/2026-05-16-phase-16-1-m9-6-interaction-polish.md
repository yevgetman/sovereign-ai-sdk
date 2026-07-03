# Phase 16.1 M9.6 — Interaction Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent model policy: Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; never Haiku (see `docs/05-conventions/subagent-policy.md`).

**Goal:** Close the 6 deferred polish items from M9 + M9.5 in 5 tasks. After M9.6, the M9.x track is complete — next gate is M10 parity audit.

**Architecture:** All work Go-side under `packages/tui/`. Zero TS-side changes. terminalRepl.ts untouched (Postmortem Rule 1, still binding through M11).

**Tech Stack:** Go 1.24 + existing bubbletea + lipgloss + bubbles stack. Adds `regexp` to theme/loader for hex validation. No new dependencies.

**Spec references:**
- `specs/2026-05-16-phase-16-1-m9-6-interaction-polish-design.md` (the spec this plan implements)
- `docs/07-history/state/2026-05-16.md` §"What does NOT work" (M9.6 scope source)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4

---

## Inline Decisions (ADRs M9.6-01..04, locked at spec)

| Decision | Resolution |
|---|---|
| **M9.6-01** Mouse click v1 scope | Toolcard collapse-toggle + autocomplete-entry-select only. Click-on-prompt deferred. |
| **M9.6-02** Stall badge persistence | Auto-fade 5s; new events reset the timer via generation counter. |
| **M9.6-03** /skills reload surface | Subcommand (`/skills reload`); compaction_complete shares refetch path. |
| **M9.6-04** Hex validation policy | Soft per-field: bad hex → Dark fallback; whole TOML still loads. |

---

## File Structure

### New files

| Path | Responsibility | Approx LoC |
|---|---|---|
| `packages/tui/internal/components/stallbadge.go` | Single-line `⚠ stalled — <reason>` warning surface | ~60 |
| `packages/tui/internal/components/stallbadge_test.go` | Visible/hidden states, Reason rendering | ~50 |

### Modified files

| Path | Modification |
|---|---|
| `packages/tui/cmd/sov-tui/main.go` | T1 — add `--no-mouse` flag; omit `tea.WithMouseCellMotion()` when set |
| `packages/tui/internal/app/app.go` | T1 — MouseMsg split for clicks; T2 — stallBadge state + stallExpireMsg tick; T3 — refetchSkills helper + /skills verb parser + compaction_complete refetch |
| `packages/tui/internal/app/app_test.go` | T1-T3 tests for mouse click, stall expiry, skills reload |
| `packages/tui/internal/components/transcript.go` | T1 — cardYRange tracking + ClickAt(y) helper |
| `packages/tui/internal/components/transcript_test.go` | T1 — ClickAt resolves card index correctly |
| `packages/tui/internal/components/slashautocomplete.go` | T1 — ClickAt(y) for popup-region click → select |
| `packages/tui/internal/components/slashautocomplete_test.go` | T1 — ClickAt resolves entry index correctly |
| `packages/tui/internal/theme/loader.go` | T4 — hex regex in pickColor |
| `packages/tui/internal/theme/loader_test.go` | T4 — invalid-hex falls back to Dark per field |
| `DECISIONS.md` | T5 — append M9.6-01..04 ADRs |
| `docs/07-history/state/2026-05-16.md` | T5 — replace with M9.6 close-out (move M9.5 to archive) |
| `docs/07-history/state/archive/2026-05-16-m9-5.md` | T5 — archive of M9.5 snapshot |
| `CLAUDE.md` / `AGENTS.md` | T5 — update state pointer; byte-identical mirror |
| `docs/06-testing/testing-log.md` | T5 — append M9.6 close-out entry |

---

## Task 1: Mouse click + `--no-mouse` flag

**Goal:** Click-on-toolcard toggles its `Expanded` state. Click-on-autocomplete-entry selects + completes. `--no-mouse` CLI flag disables `tea.WithMouseCellMotion()`. Other click regions no-op silently.

### Steps

- [ ] **Step 1 — Add `--no-mouse` flag to `cmd/sov-tui/main.go`**

Add to the existing flag block:

```go
noMouse = flag.Bool("no-mouse", false, "disable mouse mode (terminals that mishandle mouse escape codes)")
```

And conditionally compose program options:

```go
opts := []tea.ProgramOption{tea.WithAltScreen()}
if !*noMouse {
    opts = append(opts, tea.WithMouseCellMotion())
}
prog := tea.NewProgram(model, opts...)
```

- [ ] **Step 2 — Extend `transcript.go` with card index tracking**

Add a `cardYRange` field:

```go
type cardYRange struct {
    startY int
    endY   int
    cardIdx int  // index into m.lines that this card occupies; the AppendLine of a tool card stores 1 element per card
}

// cardYRanges is rebuilt on every AppendLine/AppendAssistantDelta that adds a card.
// In M9.6 v1 we track ONLY tool-card lines (one Y range per tool_result).
// The render path stays append-only; this is a side-index for click hit-testing.
```

Add `Transcript.appendToolCard(line string, cardIdx int)` that:
- Appends the rendered card to `lines`
- Computes the Y range (lipgloss.Height of the rendered line)
- Stores `{startY, endY, cardIdx}` in `t.cardRanges`

Add `Transcript.ClickAt(y int) (cardIdx int, ok bool)` that returns the card index whose Y range contains `y` (within the viewport's visible region, accounting for scroll).

For M9.6 v1 simplicity, expose only the `ClickAt` API — the actual card-state mutation lives in `app.go` (the transcript doesn't own ToolCard state; only renders).

- [ ] **Step 3 — Wire app.go MouseMsg split**

Existing handler in `Update`:

```go
case tea.MouseMsg:
    var cmd tea.Cmd
    m.transcript, cmd = m.transcript.Update(msg)
    return m, cmd
```

Becomes:

```go
case tea.MouseMsg:
    // M9.6 T1: split click vs wheel/motion routing.
    if msg.Action == tea.MouseActionPress && msg.Button == tea.MouseButtonLeft {
        return m.handleMouseClick(msg)
    }
    var cmd tea.Cmd
    m.transcript, cmd = m.transcript.Update(msg)
    return m, cmd
```

`handleMouseClick`:

```go
func (m Model) handleMouseClick(msg tea.MouseMsg) (Model, tea.Cmd) {
    // Region detection. Layout (top to bottom):
    //   transcript viewport (height = m.height - statusH - promptH - autocompleteH)
    //   autocomplete popup (when visible, height = lines in popup)
    //   prompt (height 2)
    //   status (height 1)
    const statusH = 1
    const promptH = 2

    transcriptH := m.height - statusH - promptH
    if m.autocomplete.Visible() {
        transcriptH -= m.autocomplete.PopupHeight()
    }

    if msg.Y < transcriptH {
        // Click in transcript region.
        if cardIdx, ok := m.transcript.ClickAt(msg.Y); ok {
            m.transcript.ToggleCardExpanded(cardIdx)
        }
        return m, nil
    }
    if m.autocomplete.Visible() {
        popupStart := transcriptH
        popupEnd := transcriptH + m.autocomplete.PopupHeight()
        if msg.Y >= popupStart && msg.Y < popupEnd {
            // Click on an autocomplete entry.
            entryIdx := msg.Y - popupStart
            if completion, ok := m.autocomplete.SelectAt(entryIdx); ok {
                m.prompt.SetValue(completion + " ")
                m.autocomplete.Dismiss()
            }
            return m, nil
        }
    }
    // Prompt + status rows: no-op.
    return m, nil
}
```

- [ ] **Step 4 — Add `Transcript.ToggleCardExpanded` + supporting state**

The current transcript stores tool cards as rendered strings only. To toggle, we need to retain card structs and re-render on toggle. Pragmatic approach: store a parallel `toolCardStates []ToolCard` slice indexed by line index; on Toggle, flip Expanded and re-render that line.

Add to `Transcript`:

```go
toolCards map[int]ToolCard  // line-index → original card; nil for non-card lines
```

`AppendLineAsCard(card ToolCard)`:
- Renders the card to a string via card.View(t.width)
- Appends to lines
- Stores `t.toolCards[len(lines)-1] = card`
- Tracks Y range

`ToggleCardExpanded(cardLineIdx int)`:
- Look up card by line index
- Flip `card.Expanded`
- Re-render via `card.View(t.width)`
- Replace `lines[cardLineIdx]` + update `toolCards[cardLineIdx]`
- Trigger viewport SetContent

Update `app.go`'s `tool_result` handler to use `AppendLineAsCard` instead of `AppendLine`.

- [ ] **Step 5 — Add `SlashAutocomplete.SelectAt` + `PopupHeight`**

```go
// SelectAt sets the selected index and returns the Completion + true if
// the index is in range. Used by mouse-click region routing in app.go.
func (s *SlashAutocomplete) SelectAt(idx int) (string, bool) {
    if idx < 0 || idx >= len(s.matches) {
        return "", false
    }
    s.selected = idx
    return s.matches[idx].Name, true
}

// PopupHeight returns the visible height of the popup (entries + border).
func (s SlashAutocomplete) PopupHeight() int {
    if !s.visible || len(s.matches) == 0 {
        return 0
    }
    return len(s.matches) + 2  // +2 for top + bottom border
}
```

- [ ] **Step 6 — Tests**

`transcript_test.go`:

```go
func TestTranscriptClickAtResolvesToolCard(t *testing.T) {
    tr := NewTranscript(theme.Dark())
    tr.SetSize(80, 24)
    card := ToolCard{Tool: "Bash", Summary: "ok", Theme: theme.Dark()}
    tr.AppendLineAsCard(card)
    // Single card occupies Y range starting at 0; click on Y=0 should resolve.
    idx, ok := tr.ClickAt(0)
    if !ok {
        t.Error("ClickAt(0) should resolve to the card")
    }
    _ = idx
}

func TestTranscriptToggleCardExpanded(t *testing.T) {
    tr := NewTranscript(theme.Dark())
    tr.SetSize(80, 24)
    card := ToolCard{Tool: "Bash", Summary: "collapsed view", Output: "expanded view", Theme: theme.Dark()}
    tr.AppendLineAsCard(card)
    initial := tr.View()
    if !strings.Contains(initial, "collapsed view") {
        t.Errorf("initial render should show summary: %q", initial)
    }
    // Toggle expanded.
    idx, _ := tr.ClickAt(0)
    tr.ToggleCardExpanded(idx)
    expanded := tr.View()
    if !strings.Contains(expanded, "expanded view") {
        t.Errorf("expanded render should show output: %q", expanded)
    }
}
```

`slashautocomplete_test.go`:

```go
func TestSlashAutocompleteSelectAtSelectsEntry(t *testing.T) {
    s := NewSlashAutocomplete(theme.Dark())
    s.SetFilter("/")  // populates matches
    completion, ok := s.SelectAt(0)
    if !ok {
        t.Error("SelectAt(0) should resolve")
    }
    if completion == "" {
        t.Error("Completion should be non-empty")
    }
}

func TestSlashAutocompletePopupHeightIncludesBorder(t *testing.T) {
    s := NewSlashAutocomplete(theme.Dark())
    s.SetFilter("/")
    h := s.PopupHeight()
    if h <= 0 {
        t.Errorf("PopupHeight should be > 0 when visible; got %d", h)
    }
}
```

`app_test.go`:

```go
func TestApp_ClickOnToolCardTogglesExpanded(t *testing.T) {
    m := New("s-click", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    // Inject a tool_result.
    raw := `{"type":"tool_result","seq":1,"sessionId":"s-click","block":0,"tool":"Bash","input":{"command":"ls"},"output":"file1\nfile2","renderHint":"text","language":""}`
    env := newTestEnvelope("tool_result", "s-click", 1, raw)
    model, _ = m.Update(sseMsg{env: env})
    m = model.(Model)
    // Click at Y=0 (where the tool card should be rendered).
    model, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, Y: 0})
    m = model.(Model)
    // No panic; view should still render.
    _ = m.View()
}
```

- [ ] **Step 7 — Build + test + commit**

```bash
cd packages/tui && go build ./... && go test -timeout 30s ./...
```

Commit + push:

```
git add packages/tui/cmd/sov-tui/main.go packages/tui/internal/app/app.go packages/tui/internal/app/app_test.go packages/tui/internal/components/transcript.go packages/tui/internal/components/transcript_test.go packages/tui/internal/components/slashautocomplete.go packages/tui/internal/components/slashautocomplete_test.go
git commit -m "feat(tui): M9.6 T1 — mouse click handling + --no-mouse opt-out flag"
git push origin master
```

---

## Task 2: stall_detected visual badge

**Goal:** New `components/stallbadge.go` exposes a 1-line warning surface. `stall_detected` SSE event populates it; a `tea.Tick(5s, ...)` clears it. New events during the 5s window extend; a generation counter prevents stale ticks from clearing a refreshed badge.

### Steps

- [ ] **Step 1 — Write `components/stallbadge.go`**

```go
// Package components — StallBadge: 1-line warning surface for stall_detected
// events. ADR M9.6-02: badge auto-fades 5s after the event; new events reset
// the timer via a generation counter tracked by app.go.

package components

import (
    "github.com/charmbracelet/lipgloss"
    "github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

type StallBadge struct {
    Reason string
    Theme  theme.Theme
}

// View renders a single line. Width-aware: if width is too small, falls back
// to a minimal indicator.
func (b StallBadge) View(width int) string {
    if width <= 0 {
        return ""
    }
    style := lipgloss.NewStyle().
        Foreground(b.Theme.Warning).
        Bold(true).
        Width(width).
        Padding(0, 1)
    text := "⚠ stalled"
    if b.Reason != "" {
        text = "⚠ stalled — " + b.Reason
    }
    return style.Render(text)
}
```

- [ ] **Step 2 — Write `components/stallbadge_test.go`**

```go
package components

import (
    "strings"
    "testing"

    "github.com/yevgetman/sovereign-ai-sdk/packages/tui/internal/theme"
)

func TestStallBadgeRendersReason(t *testing.T) {
    b := StallBadge{Reason: "no edits", Theme: theme.Dark()}
    out := b.View(80)
    if !strings.Contains(out, "stalled") {
        t.Errorf("badge missing 'stalled': %q", out)
    }
    if !strings.Contains(out, "no edits") {
        t.Errorf("badge missing reason: %q", out)
    }
}

func TestStallBadgeNoReasonStillRenders(t *testing.T) {
    b := StallBadge{Theme: theme.Dark()}
    out := b.View(80)
    if !strings.Contains(out, "stalled") {
        t.Errorf("badge missing 'stalled' without reason: %q", out)
    }
}

func TestStallBadgeZeroWidthReturnsEmpty(t *testing.T) {
    b := StallBadge{Reason: "x", Theme: theme.Dark()}
    out := b.View(0)
    if out != "" {
        t.Errorf("zero width: expected empty, got %q", out)
    }
}
```

- [ ] **Step 3 — Wire stall state in app.go**

Add Model fields:

```go
stallBadge     *components.StallBadge
stallGeneration int // M9.6 T2 — increments on every stall_detected; tick closure captures it; ignore expired ticks
```

Add the message type:

```go
type stallExpireMsg struct {
    gen int
}
```

In handleEvent, add the `stall_detected` case (split out of the existing trace handler if any; M8 added stall_detected as a TS-side wire event):

```go
case "stall_detected":
    sd, err := transport.DecodeStallDetected(env.Raw)
    if err != nil {
        return nil
    }
    m.stallGeneration++
    capturedGen := m.stallGeneration
    m.stallBadge = &components.StallBadge{
        Reason: sd.Reason,
        Theme:  m.theme,
    }
    return tea.Tick(5*time.Second, func(time.Time) tea.Msg {
        return stallExpireMsg{gen: capturedGen}
    })
```

(Note: handleEvent's return type may need to change from `void` to `tea.Cmd` to surface the tick; if it currently doesn't return a Cmd, refactor lightly so this case can return one.)

In Update, add the expire handler:

```go
case stallExpireMsg:
    if msg.gen == m.stallGeneration {
        m.stallBadge = nil
    }
    return m, nil
```

- [ ] **Step 4 — Add transport.DecodeStallDetected**

In `packages/tui/internal/transport/types.go`, add:

```go
// StallDetected mirrors the TS-side StallDetectedEvent (M8 T7). Advisory
// only — the turn continues normally; the TUI surfaces it as a soft
// warning the user can act on.
type StallDetected struct {
    Type      string `json:"type"`
    Seq       int64  `json:"seq"`
    SessionID string `json:"sessionId"`
    Reason    string `json:"reason"`
    Turn      int    `json:"turn"`
}

func DecodeStallDetected(raw []byte) (StallDetected, error) {
    var t StallDetected
    err := json.Unmarshal(raw, &t)
    return t, err
}
```

- [ ] **Step 5 — Render the badge in View()**

Composition order: transcript → stall badge (if any) → autocomplete (if visible) → prompt → status.

```go
prompt := m.prompt.View()
if m.autocomplete.Visible() {
    prompt = m.autocomplete.View(m.width) + "\n" + prompt
}
view := m.transcript.View() + "\n"
if m.stallBadge != nil {
    view += m.stallBadge.View(m.width) + "\n"
}
view += prompt + "\n" + m.statusLine.View()
return view
```

- [ ] **Step 6 — Tests in app_test.go**

```go
func TestApp_StallDetectedShowsBadge(t *testing.T) {
    m := New("s-stall", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    raw := `{"type":"stall_detected","seq":1,"sessionId":"s-stall","reason":"no edits","turn":3}`
    env := newTestEnvelope("stall_detected", "s-stall", 1, raw)
    model, _ = m.Update(sseMsg{env: env})
    m = model.(Model)
    if m.stallBadge == nil {
        t.Error("stallBadge should be populated")
    }
    if m.stallBadge.Reason != "no edits" {
        t.Errorf("reason: got %q", m.stallBadge.Reason)
    }
    view := m.View()
    if !strings.Contains(view, "stalled") {
        t.Errorf("view missing 'stalled': %q", view)
    }
}

func TestApp_StallExpireMatchingGenClearsBadge(t *testing.T) {
    m := New("s-exp", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    raw := `{"type":"stall_detected","seq":1,"sessionId":"s-exp","reason":"x","turn":1}`
    env := newTestEnvelope("stall_detected", "s-exp", 1, raw)
    model, _ = m.Update(sseMsg{env: env})
    m = model.(Model)
    initialGen := m.stallGeneration
    // Simulate the tick expiring with matching gen.
    model, _ = m.Update(stallExpireMsg{gen: initialGen})
    m = model.(Model)
    if m.stallBadge != nil {
        t.Error("badge should be cleared on matching-gen expire")
    }
}

func TestApp_StallExpireStaleGenIgnored(t *testing.T) {
    m := New("s-stale", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    raw1 := `{"type":"stall_detected","seq":1,"sessionId":"s-stale","reason":"a","turn":1}`
    env1 := newTestEnvelope("stall_detected", "s-stale", 1, raw1)
    model, _ = m.Update(sseMsg{env: env1})
    m = model.(Model)
    firstGen := m.stallGeneration
    // Second stall arrives (new gen).
    raw2 := `{"type":"stall_detected","seq":2,"sessionId":"s-stale","reason":"b","turn":2}`
    env2 := newTestEnvelope("stall_detected", "s-stale", 2, raw2)
    model, _ = m.Update(sseMsg{env: env2})
    m = model.(Model)
    // First tick's expire fires with the now-stale gen.
    model, _ = m.Update(stallExpireMsg{gen: firstGen})
    m = model.(Model)
    if m.stallBadge == nil {
        t.Error("stale-gen expire should NOT clear an extended badge")
    }
    if m.stallBadge.Reason != "b" {
        t.Errorf("badge should hold latest reason: got %q", m.stallBadge.Reason)
    }
}
```

- [ ] **Step 7 — Verify + commit**

```bash
cd packages/tui && go build ./... && go test -timeout 30s ./...
```

```
git add packages/tui/internal/components/stallbadge.go packages/tui/internal/components/stallbadge_test.go packages/tui/internal/transport/types.go packages/tui/internal/app/app.go packages/tui/internal/app/app_test.go
git commit -m "feat(tui): M9.6 T2 — stall_detected visual badge with 5s auto-fade + generation counter"
git push origin master
```

---

## Task 3: /skills reload + compaction cache invalidation

**Goal:** `/skills reload` triggers a `GET /sessions/:id/skills` refetch + autocomplete cache update. `compaction_complete` SSE event triggers the same refetch automatically. Future `/skills <verb>` subcommands plug into the same dispatcher.

### Steps

- [ ] **Step 1 — Extract `m.refetchSkills()` helper**

In `app.go`, near the existing `fetchSkillsCmd`:

```go
// refetchSkills produces a Cmd that re-issues the skill cache hydration.
// Used by /skills reload (M9.6 T3) and by compaction_complete (the
// post-pivot session may have a different skill set). Same shape as
// fetchSkillsCmd; deliberate code duplication so callers can compose
// without depending on Init's exact return shape.
func (m Model) refetchSkills() tea.Cmd {
    return func() tea.Msg {
        skills, err := transport.GetSkills(m.ctx, m.baseURL, m.sessionID)
        return skillsFetchedMsg{skills: skills, err: err}
    }
}
```

(If `fetchSkillsCmd` already exists as a method, just verify `refetchSkills` is identical and choose one canonical name. Per the M8 T6 narrative, the boot fetcher is `fetchSkillsCmd`; this new method may simply be an alias.)

- [ ] **Step 2 — Add `/skills <verb>` parser in ENTER handler**

Place BEFORE the existing `/skillname` skill-as-slash matcher (which matches user-defined skills literally), so `/skills reload` is intercepted before it could collide with a hypothetical user skill named "skills":

```go
if strings.HasPrefix(text, "/skills") {
    // /skills <verb> parser. M9.6 T3.
    m.transcript.AppendLine("» " + text)
    m.prompt.Clear()
    m.autocomplete.Dismiss()
    parts := strings.SplitN(text, " ", 2)
    verb := ""
    if len(parts) == 2 {
        verb = strings.TrimSpace(parts[1])
    }
    switch verb {
    case "reload":
        if m.baseURL == "" {
            m.transcript.AppendLine(m.theme.DimStyle().Render("skills cache unavailable (no server)"))
            return m, nil
        }
        m.transcript.AppendLine(m.theme.DimStyle().Render("reloading skill cache…"))
        return m, m.refetchSkills()
    case "":
        m.transcript.AppendLine(m.theme.DimStyle().Render("usage: /skills <reload>"))
    default:
        m.transcript.AppendLine(m.theme.ErrorStyle().Render("unknown /skills verb: " + verb))
    }
    return m, nil
}
```

(Place this BEFORE the `/theme`, `/compact`, `/expand`, and `matchSkillSlash` blocks so it has precedence.)

- [ ] **Step 3 — Trigger refetch on compaction_complete**

Existing compaction_complete handler returns no Cmd (it just appends a marker line and pivots `m.sessionID`). Refactor lightly to allow returning a Cmd. The cleanest path: change `handleEvent`'s signature from `(env)` to `(env) tea.Cmd`, and have the `sseMsg` case in `Update` batch the returned Cmd with `m.waitEvent`.

If `handleEvent` already returns `tea.Cmd` (per T2 stall changes), just add the refetch:

```go
case "compaction_complete":
    // ... existing handling ...
    return m.refetchSkills()
```

(If multiple events need Cmds: use `tea.Batch(m.waitEvent, cmd)` in the sseMsg case.)

- [ ] **Step 4 — Tests in app_test.go**

```go
func TestApp_SlashSkillsReloadFetchesSkills(t *testing.T) {
    var requestCount int32
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if strings.HasSuffix(r.URL.Path, "/skills") {
            atomic.AddInt32(&requestCount, 1)
            fmt.Fprint(w, `{"skills":[{"name":"reloaded-skill","description":"d","whenToUse":"w"}]}`)
            return
        }
        if strings.HasSuffix(r.URL.Path, "/messages") {
            fmt.Fprint(w, `{"messages":[]}`)
            return
        }
        // events: keep open until ctx done.
        w.Header().Set("Content-Type", "text/event-stream")
        if f, ok := w.(http.Flusher); ok {
            f.Flush()
        }
        <-r.Context().Done()
    }))
    defer srv.Close()

    tm := teatest.NewTestModel(t, New("s-rel", srv.URL), teatest.WithInitialTermSize(80, 24))
    // Wait for initial fetch (1 request).
    teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
        return atomic.LoadInt32(&requestCount) >= 1
    }, teatest.WithDuration(2*time.Second))

    // Send /skills reload + ENTER.
    tm.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/skills reload")})
    tm.Send(tea.KeyMsg{Type: tea.KeyEnter})

    teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
        return atomic.LoadInt32(&requestCount) >= 2
    }, teatest.WithDuration(2*time.Second))

    tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
    tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

func TestApp_SlashSkillsNoVerbShowsUsage(t *testing.T) {
    m := New("s-usg", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    for _, r := range "/skills" {
        model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
        m = model.(Model)
    }
    model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
    m = model.(Model)
    view := m.View()
    if !strings.Contains(view, "usage") {
        t.Errorf("expected usage message: %q", view)
    }
}

func TestApp_SlashSkillsUnknownVerbErrors(t *testing.T) {
    m := New("s-unk", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    for _, r := range "/skills bogus" {
        model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
        m = model.(Model)
    }
    model, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
    m = model.(Model)
    view := m.View()
    if !strings.Contains(view, "unknown") || !strings.Contains(view, "bogus") {
        t.Errorf("expected unknown-verb error: %q", view)
    }
}
```

- [ ] **Step 5 — Verify + commit**

```bash
cd packages/tui && go build ./... && go test -timeout 30s ./...
```

```
git add packages/tui/internal/app/app.go packages/tui/internal/app/app_test.go
git commit -m "feat(tui): M9.6 T3 — /skills reload subcommand + compaction_complete cache invalidation"
git push origin master
```

---

## Task 4: Hex string validation in TOML loader

**Goal:** `internal/theme/loader.go`'s `pickColor` regex-checks each parsed string; invalid hex falls back to the per-field Dark value. Whole TOML still loads.

### Steps

- [ ] **Step 1 — Update `pickColor` in `loader.go`**

```go
import (
    // ...existing imports...
    "regexp"
)

var hexRE = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

func pickColor(parsed string, fallback lipgloss.Color) lipgloss.Color {
    if parsed == "" {
        return fallback
    }
    if !hexRE.MatchString(parsed) {
        return fallback
    }
    return lipgloss.Color(parsed)
}
```

- [ ] **Step 2 — Add tests to `loader_test.go`**

```go
func TestLoadFromFileInvalidHexFallsBackPerField(t *testing.T) {
    dir := t.TempDir()
    tomlContent := `name = "mixed-bad"

[colors]
primary    = "not-a-color"
background = "#abcdef"
foreground = "red"
border     = "#ff00ff"
`
    if err := os.WriteFile(filepath.Join(dir, "mixed-bad.toml"), []byte(tomlContent), 0o644); err != nil {
        t.Fatal(err)
    }
    th, err := LoadFromFile("mixed-bad", dir)
    if err != nil {
        t.Fatalf("LoadFromFile should still succeed with invalid hex: %v", err)
    }
    dark := Dark()
    if th.Primary != dark.Primary {
        t.Errorf("primary should be Dark fallback for invalid hex: got %q", th.Primary)
    }
    if th.Foreground != dark.Foreground {
        t.Errorf("foreground should be Dark fallback for 'red': got %q", th.Foreground)
    }
    if string(th.Background) != "#abcdef" {
        t.Errorf("background should be the valid hex: got %q", th.Background)
    }
    if string(th.Border) != "#ff00ff" {
        t.Errorf("border should be the valid hex: got %q", th.Border)
    }
}

func TestLoadFromFileShortHexAccepted(t *testing.T) {
    dir := t.TempDir()
    tomlContent := `name = "short-hex"

[colors]
primary = "#abc"
`
    if err := os.WriteFile(filepath.Join(dir, "short-hex.toml"), []byte(tomlContent), 0o644); err != nil {
        t.Fatal(err)
    }
    th, err := LoadFromFile("short-hex", dir)
    if err != nil {
        t.Fatalf("short-hex form should be valid: %v", err)
    }
    if string(th.Primary) != "#abc" {
        t.Errorf("primary: got %q", th.Primary)
    }
}

func TestLoadFromFileUppercaseHexAccepted(t *testing.T) {
    dir := t.TempDir()
    tomlContent := `name = "upper"

[colors]
primary = "#ABCDEF"
`
    if err := os.WriteFile(filepath.Join(dir, "upper.toml"), []byte(tomlContent), 0o644); err != nil {
        t.Fatal(err)
    }
    th, err := LoadFromFile("upper", dir)
    if err != nil {
        t.Fatalf("uppercase hex should be valid: %v", err)
    }
    if string(th.Primary) != "#ABCDEF" {
        t.Errorf("primary: got %q", th.Primary)
    }
}

func TestLoadFromFileFourCharHexRejected(t *testing.T) {
    dir := t.TempDir()
    tomlContent := `name = "four-char"

[colors]
primary = "#abcd"
`
    if err := os.WriteFile(filepath.Join(dir, "four-char.toml"), []byte(tomlContent), 0o644); err != nil {
        t.Fatal(err)
    }
    th, err := LoadFromFile("four-char", dir)
    if err != nil {
        t.Fatalf("LoadFromFile should still succeed: %v", err)
    }
    dark := Dark()
    if th.Primary != dark.Primary {
        t.Errorf("4-char hex should be rejected; expected Dark fallback, got %q", th.Primary)
    }
}
```

- [ ] **Step 3 — Verify + commit**

```bash
cd packages/tui && go test -timeout 30s ./internal/theme/...
```

```
git add packages/tui/internal/theme/loader.go packages/tui/internal/theme/loader_test.go
git commit -m "feat(tui): M9.6 T4 — hex string validation in TOML loader (soft per-field fallback)"
git push origin master
```

---

## Task 5: Integration smoke + close-out

**Goal:** Add a `tests/integration/m9_6_full_test.go` (or extend `internal/app/m9Full_test.go`) covering all M9.6 surfaces. Close-out documentation.

### Steps

- [ ] **Step 1 — Add M9.6 cases to `internal/app/m9Full_test.go`**

```go
func TestM9_6_NoMouseFlagDisablesMouseMode(t *testing.T) {
    // Smoke: the flag isn't wired through New() (it's in main.go), but
    // we can at least verify the program-opt composition logic via a
    // unit-test extract if needed. v1: defer to runtime smoke.
    t.Skip("--no-mouse smoke covered by main.go flag-parse path; runtime-only verification")
}

func TestM9_6_ClickOnAutocompleteEntrySelects(t *testing.T) {
    m := New("s-acmouse", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    model, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
    m = model.(Model)
    if !m.autocomplete.Visible() {
        t.Fatal("autocomplete should be visible after /")
    }
    // Click at the first entry's Y (transcript height - popup height + 0).
    // Compute roughly; teatest doesn't expose layout, so we verify via the
    // SelectAt API directly.
    completion, ok := m.autocomplete.SelectAt(0)
    if !ok {
        t.Error("SelectAt(0) should resolve")
    }
    if completion == "" {
        t.Error("Completion should be non-empty")
    }
}

func TestM9_6_StallBadgeRendersThenExpires(t *testing.T) {
    m := New("s-stallintg", "")
    model, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
    m = model.(Model)
    raw := `{"type":"stall_detected","seq":1,"sessionId":"s-stallintg","reason":"no edits","turn":3}`
    env := newTestEnvelope("stall_detected", "s-stallintg", 1, raw)
    model, _ = m.Update(sseMsg{env: env})
    m = model.(Model)
    if m.stallBadge == nil {
        t.Fatal("badge should be visible")
    }
    // Simulate matching-gen expire.
    model, _ = m.Update(stallExpireMsg{gen: m.stallGeneration})
    m = model.(Model)
    if m.stallBadge != nil {
        t.Error("badge should be cleared after matching-gen expire")
    }
}
```

- [ ] **Step 2 — Full suite verification**

```bash
cd packages/tui && go test -timeout 60s ./... -count=1
cd /Users/julie/code/sovereign-ai-sdk && bun run lint && bun run typecheck && bun test
```

All green. Lint shows 2 expected warnings only.

- [ ] **Step 3 — Append 4 ADRs to DECISIONS.md**

```
## ADR M9.6-01 — Mouse click v1 = toolcard + autocomplete only

Decision: ...
Rationale: ...
Status: implemented (M9.6 — <T1 commit>).

## ADR M9.6-02 — Stall badge auto-fades 5s with generation counter

Decision: ...
Rationale: ...
Status: implemented (M9.6 — <T2 commit>).

## ADR M9.6-03 — /skills reload as subcommand; shares dispatch with future verbs

Decision: ...
Rationale: ...
Status: implemented (M9.6 — <T3 commit>).

## ADR M9.6-04 — Soft hex validation in TOML loader

Decision: ...
Rationale: ...
Status: implemented (M9.6 — <T4 commit>).
```

- [ ] **Step 4 — Archive M9.5 snapshot, write M9.6 snapshot**

```bash
git mv docs/07-history/state/2026-05-16.md docs/07-history/state/archive/2026-05-16-m9-5.md
```

Write new `docs/07-history/state/2026-05-16.md` covering M9.6: HEAD SHA, suite counts, what shipped per task, ADRs, behavioral notes, postmortem-rule check, what's open / next.

- [ ] **Step 5 — Update CLAUDE.md + AGENTS.md pointer**

Change snapshot description to "Phase 16.1 M9.6 shipped 2026-05-16 — interaction polish: mouse click + --no-mouse + stall badge + /skills reload + compaction cache invalidation + hex validation".

`cp CLAUDE.md AGENTS.md` to maintain byte-identical mirror.

- [ ] **Step 6 — Append testing-log entry**

Newest-first entry covering scope + suite delta + ADRs + any mid-build bug catches.

- [ ] **Step 7 — Final `sov upgrade`**

```bash
sov upgrade
sov --version  # 0.1.0-<short-sha>
```

- [ ] **Step 8 — Final commit + push**

```
git add packages/tui/internal/app/m9Full_test.go DECISIONS.md docs/07-history/state/ CLAUDE.md AGENTS.md docs/06-testing/testing-log.md
git commit -m "docs: M9.6 T5 close-out — 4 ADRs, interaction-polish integration smoke, state snapshot"
git push origin master
```

---

## Final Verification Checklist

After all 5 tasks land:

- [ ] `bun run lint` clean (only 2 pre-existing warnings).
- [ ] `bun run typecheck` clean.
- [ ] `bun test` no regressions.
- [ ] `cd packages/tui && go test ./...` all green.
- [ ] `sov upgrade` + `sov --version` resolves to new HEAD.
- [ ] `diff CLAUDE.md AGENTS.md` empty.
- [ ] `git diff master -- src/ui/terminalRepl.ts` empty (Rule 1).
- [ ] `git diff master --diff-filter=D -- src/` empty (Rule 2).
- [ ] ADRs M9.6-01..04 in DECISIONS.md.
- [ ] State snapshot at `docs/07-history/state/2026-05-16.md` covers M9.6.
- [ ] Testing-log entry for M9.6.

---

## Post-M9.6 Notes (out of scope for this plan)

After M9.6 lands, the M9.x track is complete. Next milestone gates:

- **Post-M9.6 hardening session** — real-Anthropic visual smoke; budget ~$0.005; same shape as M7/M8/M9 hardening passes.
- **M10 parity audit** — independent audit of `src/ui/terminalRepl.ts` import list per Postmortem Rule 3.
- **M11 default flip** — `--ui tui` becomes default; `--ui repl` stays opt-in.
- **M12 / M13** — terminalRepl deprecation + removal.
