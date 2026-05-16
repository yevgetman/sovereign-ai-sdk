# Phase 16.1 M9.6 — Interaction Polish · Design Spec

Status: **draft** — written 2026-05-16, ready for implementation plan
Supersedes: nothing (closes 6 deferred items from M9 + M9.5)
Authority: enforces Rules 1–4 of `docs/postmortems/2026-05-12-phase-16-revert.md`

---

## 1. Purpose

Close the six interaction-polish items deferred from M9 (mouse click handling, `--no-mouse` flag, `stall_detected` visual badge, `/skills reload`, autocomplete cache invalidation on compaction) and M9.5 (hex string validation in the TOML loader). After M9.6 the M9.x track is complete; the next milestone gate is M10 (parity audit).

Each item is small, mostly independent, and orthogonal to the rest. The natural shape is 5 tasks (some items bundle by code path; close-out is its own task). No new wire surfaces — every change consumes existing M8/M9 events or extends existing slash dispatch.

## 2. Goal

When M9.6 completes:

1. **Mouse click handling.** Click-on-toolcard toggles the card's `Expanded` field. Click-on-autocomplete-entry selects the entry and Tab-completes. Click events on dead transcript area are no-ops (no panic).
2. **`--no-mouse` opt-out.** `sov-tui --no-mouse` boots without `tea.WithMouseCellMotion()` so terminals that misbehave on mouse escape codes stay usable.
3. **`stall_detected` visual badge.** Statusline shows `⚠ stalled — <reason>` in `theme.Warning` for 5 seconds after a `stall_detected` SSE event arrives. New stall resets the 5-second timer; the badge auto-clears.
4. **`/skills reload` slash command.** User can refresh the skill cache without restarting. Parses as `/skills reload`; future verbs (`/skills list`, `/skills show`) plug into the same dispatch table.
5. **Cache invalidation on `compaction_complete`.** Automatic refetch when a session-id pivot lands (compaction-driven or proactive). Shares code with `/skills reload`.
6. **Hex string validation in TOML loader.** Invalid hex codes (anything that doesn't match `#rgb` or `#rrggbb`) fall back to the corresponding `Dark()` field. The whole TOML still loads — only bad fields drop. A 12-of-13-valid TOML produces a 12-color theme.

**Done =**

- All 5 tasks landed,
- Go suite green; TS suite unchanged at 1997/1997 (no TS-side changes in M9.6),
- Lint + typecheck clean,
- A user clicking a tool card sees it toggle expanded/collapsed,
- `sov-tui --no-mouse` boots without consuming mouse escape codes,
- A simulated `stall_detected` event paints the badge for 5s then clears,
- `/skills reload` reissues the GET /skills request and updates the autocomplete cache,
- A TOML with `primary = "not-a-hex"` parses + renders with Dark's primary in that field's place.

**Explicitly NOT done in M9.6:** click-on-prompt focus, `/skills list` / `/skills show` subcommands, hover tooltips, real-Anthropic visual smoke, any change to `src/ui/terminalRepl.ts`. M10 parity audit + M11 default flip still ahead.

## 3. Architecture

### 3.1 Mouse click routing (T1)

Click events land as `tea.MouseMsg` in `app.go`'s `Update`. We already forward all `tea.MouseMsg` events to the transcript viewport (M9 T9) for wheel scroll. M9.6 splits the handler:

```go
case tea.MouseMsg:
    if msg.Action == tea.MouseActionPress && msg.Button == tea.MouseButtonLeft {
        // Click — dispatch by Y-coordinate against transcript / autocomplete / prompt regions.
        return m.handleMouseClick(msg)
    }
    // Wheel / motion — forward to transcript (existing M9 T9 behavior).
    var cmd tea.Cmd
    m.transcript, cmd = m.transcript.Update(msg)
    return m, cmd
```

`handleMouseClick` computes which screen region the click hit:

- Above transcript bottom → transcript area → if click is on a card, find the card by Y-offset and toggle its `Expanded` field. v1: track card Y-offsets in a small `[]cardYRange` slice on `Transcript`.
- Inside autocomplete popup region → map Y-offset to entry index, set as selected, then Tab-complete.
- Prompt row → no-op (textinput is focused by default).
- Status line → no-op.

Click region detection uses cached Y-ranges populated by `transcript.RebuildCardIndex()` after every `AppendLine` / `AppendAssistantDelta` / `RemoveLastLine`. The autocomplete popup tracks its own Y-range from `app.View()`'s prompt-popup-statusline composition.

### 3.2 `--no-mouse` flag (T1)

`cmd/sov-tui/main.go` adds a `--no-mouse` bool flag. When set, the `tea.NewProgram` call omits `tea.WithMouseCellMotion()`. The TUI still functions; mouse events simply never arrive.

### 3.3 Stall badge (T2)

New `components/stallbadge.go` exposes a `StallBadge` struct:

```go
type StallBadge struct {
    Visible bool
    Reason  string
    Theme   theme.Theme
}

func (b StallBadge) View() string { ... }
```

`app.go` holds `m.stallBadge *components.StallBadge`. On `stall_detected` SSE event:
- Build a new badge, attach to `m.stallBadge`.
- Return a `tea.Tick(5*time.Second, ...)` that emits a `stallExpireMsg`.

`stallExpireMsg` handler clears `m.stallBadge` if no NEW stall event has arrived since (track sequence via a `stallGeneration` counter on the model — incremented on each stall, captured in the tick closure, compared on expire).

`View()` composition: when `m.stallBadge != nil && m.stallBadge.Visible`, the badge renders as a single line ABOVE the status line, between transcript and prompt-statusline rows.

### 3.4 `/skills reload` + cache invalidation (T3)

Extract `m.refetchSkills() tea.Cmd` — does what `fetchSkillsCmd` does on boot. Two call sites consume it:

1. **`/skills reload` slash handler** in app.go's ENTER block (intercept before the existing `/skills*` skill-as-slash matcher — `/skills reload` must take precedence over any user skill literally named "skills").
2. **`compaction_complete` SSE event handler** in `handleEvent` — after pivoting `m.sessionID`, return the refetch cmd alongside the existing handling. The skill cache must reflect skills available under the new (child) session id.

The handler signature for `compaction_complete` already returns a tea.Cmd through the existing handleEvent → sseMsg case. We add the refetch cmd to the batch.

Dispatch parse for `/skills <verb>`:

```go
if strings.HasPrefix(text, "/skills") {
    parts := strings.SplitN(text, " ", 2)
    verb := ""
    if len(parts) == 2 {
        verb = strings.TrimSpace(parts[1])
    }
    switch verb {
    case "reload":
        // refetch + render dim marker
    default:
        // unknown verb — render usage line
    }
}
```

`/skills` with no verb prints usage; future verbs add cases.

### 3.5 Hex validation in TOML loader (T4)

`internal/theme/loader.go`'s `pickColor` becomes hex-aware:

```go
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

Soft: bad hex silently falls back per ADR M9.6-04. The loader does NOT log per bad field (would be noisy on multi-bad TOMLs); aggregate validation surface deferred.

### 3.6 Sub-component summary

```
packages/tui/internal/
├── app/
│   ├── app.go              EXTEND — MouseMsg split, stallBadge state,
│   │                                stallExpireMsg case, refetchSkills helper,
│   │                                /skills <verb> parser
│   └── (no new files in M9.6)
├── components/
│   ├── stallbadge.go       ← NEW — single-line warning surface
│   ├── stallbadge_test.go  ← NEW
│   ├── transcript.go       EXTEND — cardYRange tracking + ClickAt(y) helper
│   ├── transcript_test.go  EXTEND
│   ├── toolcard.go         UNTOUCHED (Expanded toggle done by transcript-level handler)
│   ├── slashautocomplete.go EXTEND — ClickAt(y) helper for popup-region click→select
│   └── slashautocomplete_test.go EXTEND
├── theme/
│   ├── loader.go           EXTEND — hex regex validation in pickColor
│   └── loader_test.go      EXTEND
└── cmd/sov-tui/
    └── main.go             EXTEND — --no-mouse flag
```

## 4. Decisions Locked In This Spec

Four ADRs land at close-out:

1. **M9.6-01** — Mouse click v1 = toolcard collapse-toggle + autocomplete-entry-select only. Click-on-prompt deferred. Rationale: textinput is focused by default; click-to-focus introduces interaction with the permission modal + diff-view focus stack that warrants its own design pass.

2. **M9.6-02** — `stall_detected` badge auto-fades 5s after the event. New events reset the timer. Rationale: persistent badge crowds the statusline indefinitely on a long-stalled session; 5s is enough to read + react without becoming permanent noise. Matches the "soft warning" surface the M8 T7 spec called for.

3. **M9.6-03** — `/skills reload` is a subcommand (`/skills reload`), not a top-level `/skills-reload`. Future verbs (`/skills list`, `/skills show`) plug into the same dispatcher. `compaction_complete` triggers the same refetch path automatically. Rationale: avoids top-level slash namespace pollution; matches the M8 pattern of subcommand-style slash extension.

4. **M9.6-04** — Hex validation is soft: bad hex falls back to the corresponding `Dark()` field. Whole-TOML rejection would punish users for typos in 1 of 13 colors. Matches ADR M9.5-03 partial-file fallback policy.

## 5. Task Decomposition

| # | Task | Tests |
|---|---|---|
| **T1** | Mouse click + `--no-mouse` flag | Click-on-toolcard toggles Expanded; click-on-autocomplete-entry selects; click-on-dead-area no-ops; `--no-mouse` flag passes through to `tea.NewProgram`. |
| **T2** | stall_detected badge | New `stall_detected` event sets badge visible; 5s tick clears it; new event during the 5s window extends. |
| **T3** | `/skills reload` + compaction invalidation | `/skills reload` refetches; `compaction_complete` event triggers same refetch; `/skills` with no verb prints usage. |
| **T4** | Hex validation in TOML | Invalid `#xyz` falls back to Dark's field; mixed valid+invalid TOML loads partially; `#rgb` short form accepted; non-hex strings (e.g. `red`) rejected. |
| **T5** | Integration smoke + close-out | Mouse + stall + skills + hex all round-trip through unit tests; 4 ADRs M9.6-01..04 in DECISIONS; state snapshot; CLAUDE.md/AGENTS.md; testing-log; `sov upgrade`. |

## 6. Error Handling

- **Mouse click outside known regions**: silent no-op. No error propagation.
- **stall_detected event without `reason` field**: badge renders with empty reason; still visible for 5s. Schema makes reason required; defensive in case wire shape drifts.
- **`/skills reload` while no server connected (`baseURL == ""`)**: dim marker `skills cache unavailable`; no fetch attempted.
- **`/skills reload` server 5xx**: dim marker with the error; existing m.skills retained (don't drop on failure).
- **`compaction_complete` refetch failure**: silent no-op (the compaction marker already lands; failing the skill refetch quietly is preferable to spamming the transcript).
- **Hex validation regex compile failure**: impossible (compile-time regex), but the loader would still fall back to Dark per the existing `parsed == ""` path.

## 7. Testing Strategy

- **Go unit** (`go test`): every new/modified file gets a `_test.go` peer. Cumulative ~12 new tests across T1–T4 + T5 integration smoke.
- **No TS-side changes**, so no new TS tests.
- **`sov upgrade`** after every `packages/tui/` change.
- **Postmortem rules 1+2** verified at T5 close-out.

## 8. Postmortem-Rule Compliance Check

Verified at close-out:

- **Rule 1** — `src/ui/terminalRepl.ts` untouched.
- **Rule 2** — no helper module deletion.
- **Rule 3** — parity audit: NOT done in M9.6. M10's job.
- **Rule 4** — `--ui tui` stays opt-in through M11.

## 9. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Click-region detection drifts as transcript scrolls | low | Y-ranges are recomputed each `View()`; viewport tracks its own scroll offset internally; we map clicks against the viewport's visible region. |
| `tea.Tick` for stall expiry races with new stall event | low | Generation counter — tick closure captures the current gen; on fire, compares against current model gen; mismatched generations ignore the tick. |
| `--no-mouse` flag doesn't reach the program before mouse mode is registered | low | Flag parsed in `main()` BEFORE `tea.NewProgram` call; trivial. |
| `/skills reload` race against compaction-driven refetch | very low | TUI is single-threaded through `tea.Model.Update`; can't race itself. |
| Hex regex too restrictive | low | Accepts `#rgb` and `#rrggbb` (the two common forms); rejects everything else. RGBA / named colors are NOT supported (out of scope for v1). |

## 10. Self-Review

Spec checked against the brainstorming-skill checklist 2026-05-16-pre-commit:

- **Placeholder scan:** No TBD / TODO / vague items.
- **Internal consistency:** Architecture (§3) matches Tasks (§5). ADRs (§4) match decisions in architecture sections.
- **Scope check:** 5 tasks, all touching the Go side with the exception of zero TS-side changes. Single implementation plan.
- **Ambiguity check:** Click region detection (§3.1) calls out the Y-offset tracking explicitly; stall fade-then-reset (§3.3) calls out the generation counter; `/skills reload` (§3.4) calls out the parse precedence with the existing `/skillname` matcher.

## 11. Next Steps

1. Write implementation plan at `docs/plans/2026-05-16-phase-16-1-m9-6-interaction-polish.md`.
2. Execute T1–T5.
3. Close-out per the template: state snapshot + CLAUDE.md/AGENTS.md update + ADRs M9.6-01..04 in DECISIONS.md + testing-log entry.
4. Push to origin/master after each commit per `docs/conventions/lint-and-commit.md`.
