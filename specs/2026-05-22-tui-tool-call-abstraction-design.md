# TUI tool-call abstraction + two surgical UX fixes — design

**Status:** approved 2026-05-22 — execution authorized autonomously by the user immediately after design approval; spec drives implementation directly without a separate plan file.
**Author:** brainstorming session 2026-05-22
**Phase:** post-Phase-21-M1 polish (no milestone tag)

## Motivation

Three UX issues surfaced from screenshots taken on the user's macOS terminal against `~/.sov/bin/sov` v0.2.1:

1. **`ux1.png`** — the launcher emits a `sov: tui server listening on 127.0.0.1:PORT session=…` stderr line above the splash. Boot noise. Should be silent.
2. **`ux2.png`** — fenced code blocks in assistant responses render as flat dim text on this user's terminal palette. No visible syntax-token differentiation. The current `catppuccin-mocha` chroma style is being quantized.
3. **`tool-calls1/2.png`** — every `tool_result` renders as a full bordered card with the tool's complete raw output expanded. For tools like `Bash`, `Grep`, and large `FileRead` calls, this produces a wall of meaningless text in scrollback (often dozens of lines) that the user has to skim past to find the next assistant message. The Claude mobile app screenshot (`tool-calls--claude-example.jpeg`) shows the preferred shape: one line per call, e.g. `Edited app.go +11 -7 ›`, with a chevron hinting that more detail is available.

(3) is the bulk of the work. (1) and (2) are surgical fixes folded into the same milestone.

## Goals

- Two tool-call rendering modes — **compact** (default) and **detailed** (opt-in via config).
- Compact mode matches the Claude mobile aesthetic: one line per `tool_result`, `[glyph?] Verb target stats  ›`.
- Detailed mode reuses the existing bordered `ToolCard`, but always truncates output to `inlineLines` (default 10) — never raw.
- `-v / --verbose` flag remains as an orthogonal escape hatch — prints the raw untruncated output below either mode's rendering.
- Verb mapping owned by the Go TUI. Zero changes to the Anthropic-shaped wire `ToolResult` event for this milestone.
- Remove the launcher's boot-line stderr noise.
- Switch the dark-theme chroma style from `catppuccin-mocha` to `monokai` for visible syntax highlighting.

## Non-goals

- Tool-side `compactSummary` wire field. A clean future evolution (Approach B from the brainstorm) but not in this milestone. Spec notes the upgrade path.
- Wire-level `isError` / `isDenied` fields on `ToolResult`. Detection via Output JSON parse + raw-text prefix match is robust enough.
- Interactive selection of compact lines (arrow-key navigation, Enter-to-expand). Incompatible with the round-5 immutable-scrollback model. `/expand N` remains the only affordance.
- Per-tool theming of the chevron or verb color. Single visual treatment.
- A third "raw" config mode. `-v` is the raw escape hatch; raw never persists.

## Locked decisions (from brainstorm Q&A)

| # | Question | Answer |
|---|---|---|
| Q1 | What does the user see while a tool is running? | **Silent.** The thinking spinner (already in LiveRegion) covers in-flight feedback. Compact line emits only on `tool_result`. No `…running <Tool>` indicator. No transient cursor-overwrite. |
| Q2 | Right-side cue on each compact line? | **Chevron only.** `›` visual hint that detail is available. No numbered index. `/expand 1`, `/expand 2` remain positional from most-recent. |
| Q3 | Per-tool verb mapping? | **Approved as proposed** (see Per-tool format table below). Past-tense verbs for completed actions. |
| Q4 | Error / permission visual marking? | **Two glyphs.** `⚠` (`theme.Warning`, yellow) prefix for permission denied / cancelled. `✗` (`theme.Error`, red) prefix for runtime tool errors (`status:'error'` envelope). |
| Q5 | `-v / --verbose` flag fit? | **Orthogonal raw escape hatch.** Three effective levels: compact, detailed, `-v` raw. `-v` always prints full untruncated output below the rendered line/card, regardless of mode. No per-run mode flip. |
| Q6 | Config shape? | **Extend the existing `ui.toolOutput` field.** Add `mode: 'compact' \| 'detailed'` (default `'compact'`). Keep `inlineLines: number` (default `10`) as the truncation cap for detailed mode. |
| A | Fix the `tui server listening…` stderr line? | **Delete entirely.** Boot is silent. No env-gated retention. |
| B | Code block syntax highlighting? | **Switch default dark style to `monokai`.** Light theme stays `catppuccin-latte`. No `termenv.TrueColor` force (M11.7 lesson). |
| Arch | Where the verb mapping lives? | **Approach A — all-Go rendering layer.** New `packages/tui/internal/components/compactline.go`. Zero wire-schema churn. |

## Architecture

```
Boot (TS)                            Runtime (Go)
────────                             ────────────
sov reads ui.toolOutput.{mode,       Model{
  inlineLines} from user-settings.     toolOutputMode      string   // "compact" | "detailed"
                                       toolOutputInlineLines int    // default 10
sov-tui spawned with new flags:        verboseRaw          bool
  --tool-output-mode compact         }
  --tool-output-inline-lines 10
  (existing flags unchanged)         tool_result event:
                                       1. detectStatus(Output) → (isError, isDenied)
sov stderr line at                     2. switch m.toolOutputMode:
tuiLauncher.ts:293 removed.              "compact"  → m.print(formatCompactToolLine(...))
                                         "detailed" → m.print(toolCard.View(width))
                                       3. if m.verboseRaw → m.print(rawOutputBlock)

dark-theme chroma style              /expand N continues to work via
in render/code.go switches           m.completedBlocks ring (unchanged).
to monokai.
```

## Components

### TS side

**`src/config/schema.ts` — extend `ui.toolOutput`:**

```ts
toolOutput: z
  .object({
    /** Default 'compact' — one line per tool call. 'detailed' opts into
     *  the bordered card with output truncated to inlineLines. -v / --verbose
     *  bypasses both and prints the full raw output below the rendering. */
    mode: z.enum(['compact', 'detailed']).optional(),
    /** Truncation cap for detailed mode. Default 10. inlineLines: 0
     *  collapses detailed mode to header-only. */
    inlineLines: z.number().int().min(0).max(200).optional(),
  })
  .strict()
  .optional()
```

**`src/cli/tuiLauncher.ts`:**
- Delete the `process.stderr.write('sov: tui server listening on …')` at line 293.
- Forward `ui.toolOutput.mode` + `ui.toolOutput.inlineLines` as new flags to `sov-tui`:
  - `--tool-output-mode <compact|detailed>`
  - `--tool-output-inline-lines <n>`
- Honor existing `-v / --verbose` plumbing: forward as `--verbose-raw` to `sov-tui`.

### Go side

**`packages/tui/internal/components/compactline.go` (NEW):**

Public API:

```go
// FormatCompactToolLine renders a single-line compact representation of
// a tool_result event. Returns the rendered string (without trailing
// chevron — caller appends) and status flags so the caller can pick
// prefix glyph + color.
//
// width is the terminal width minus chrome margin.
func FormatCompactToolLine(
    tool string,
    input json.RawMessage,
    output json.RawMessage,
    t theme.Theme,
    width int,
) (line string, isError, isDenied bool)
```

Internal structure:

```go
var compactVerbs = map[string]string{
    "FileRead":       "Read",
    "FileWrite":      "Wrote",
    "FileEdit":       "Edited",
    "Bash":           "Ran",
    "Grep":           "Grep",
    "Glob":           "Glob",
    "WebFetch":       "Fetched",
    "WebSearch":      "Web search",
    "MemoryRead":     "Read memory",
    "MemoryWrite":    "Wrote memory",
    "MemoryEdit":     "Edited memory",
    "MemoryPropose":  "Proposed memory",
    "SkillPropose":   "Proposed skill",
}

func formatTarget(tool string, input json.RawMessage, output json.RawMessage) string {
    switch tool {
    case "FileRead", "FileWrite":   return extractPath(input)
    case "FileEdit":                return extractPath(input) + " " + extractDiffStats(output)
    case "Bash":                    return "$ " + extractCommandPreview(input)
    case "Grep":                    return "'" + extractPattern(input) + "'" + scopeSuffix(input)
    case "Glob":                    return "'" + extractPattern(input) + "'" + matchCountSuffix(output)
    case "WebFetch":                return truncateUrl(extractURL(input))
    case "WebSearch":               return "'" + extractQuery(input) + "'"
    case "MemoryRead", "MemoryWrite", "MemoryEdit": return extractMemoryFile(input)
    case "MemoryPropose":           return "'" + extractName(input) + "'"
    case "SkillPropose":            return "'" + extractName(input) + "'"
    }
    if strings.HasPrefix(tool, "mcp__") {
        return formatMCPTarget(tool, input)  // <server>: <toolname> <preview>
    }
    return truncatePreview(string(input), 40)  // unknown-tool fallback
}

func detectStatus(output json.RawMessage) (isError, isDenied bool) {
    // Parse {status, summary, ...} envelope.
    var env struct{ Status, Summary string }
    if err := json.Unmarshal(output, &env); err == nil && env.Status == "error" {
        return true, false
    }
    // Permission denials surface as bare-text "permission denied: <reason>"
    // emitted by orchestrator.ts deny branch.
    raw := strings.TrimSpace(string(output))
    raw = strings.TrimPrefix(raw, `"`)  // tolerate JSON-string wrapping
    if strings.HasPrefix(raw, "permission denied") {
        return true, true
    }
    return false, false
}
```

Helper extractors (`extractPath`, `extractDiffStats`, `extractCommandPreview`, etc.) live in the same file. `extractDiffStats` parses the unified-diff Output to compute `+N -M` — reusable from the existing `DiffView` hunk parser.

**`packages/tui/internal/app/app.go` — `tool_result` handler (around line 1295):**

Replace the current "always build a `ToolCard`, always `Expanded: true`" block with:

```go
case "tool_result":
    tr, err := transport.DecodeToolResult(env.Raw)
    if err != nil {
        return nil
    }
    m.clearThinkingIfPending()
    if rendered, ok := m.live.EndAssistantCard(); ok {
        m.print(rendered)
    }

    line, isError, isDenied := components.FormatCompactToolLine(
        tr.Tool, tr.Input, tr.Output, m.theme, m.width,
    )
    prefix := ""
    if isDenied {
        prefix = lipgloss.NewStyle().Foreground(m.theme.Warning).Render("⚠ ")
    } else if isError {
        prefix = lipgloss.NewStyle().Foreground(m.theme.Error).Render("✗ ")
    }
    chevron := lipgloss.NewStyle().Foreground(m.theme.Dim).Render(" ›")

    switch m.toolOutputMode {
    case "detailed":
        // Existing ToolCard path, but with hard-cap truncation.
        // [build card as today, then truncate output to m.toolOutputInlineLines]
        m.print(card.View(m.width))
    default:  // "compact"
        m.print(prefix + line + chevron)
    }

    if m.verboseRaw {
        m.print(renderRawOutput(tr.Output, m.theme, m.width))
    }

    m.appendCompletedBlock(CompletedBlock{
        Seq:    env.Seq,
        Tool:   tr.Tool,
        Output: string(tr.Output),
    })
    return m.scheduleIdleCheck()
```

**`packages/tui/internal/components/toolcard.go` — detailed-mode truncation:**

Add an `InlineLines int` field. When `Expanded` and `InlineLines > 0`, the body renders only the first `InlineLines` rows of Output followed by a dim `…[+N more lines]` footer. `InlineLines == 0` collapses to header-only. The existing `Diff` path is unaffected (diffs already render compactly via DiffView).

**`packages/tui/internal/render/code.go:46-57` — chroma style switch:**

```go
func chromaStyleForTheme(t theme.Theme) *chroma.Style {
    if t.Name == "light" {
        if s := styles.Get("catppuccin-latte"); s != nil && s.Name != "swapoff" {
            return s
        }
        return styles.Get("github")
    }
    if s := styles.Get("monokai"); s != nil && s.Name != "swapoff" {
        return s
    }
    return styles.Get("catppuccin-mocha")  // last-ditch fallback
}
```

**`packages/tui/cmd/sov-tui/main.go` (or wherever the launcher main parses flags):**
- Add `--tool-output-mode` (string, default `"compact"`) and `--tool-output-inline-lines` (int, default `10`).
- Add `--verbose-raw` (bool, default `false`).
- Thread into `Model` at construction.

## Data flow

1. **Boot.** `sov` reads `userSettings.ui.toolOutput.{mode, inlineLines}` from config and passes them to `sov-tui` via CLI flags. `-v / --verbose` is forwarded as `--verbose-raw`.
2. **Model init.** Go `main.go` parses flags into `Model{toolOutputMode, toolOutputInlineLines, verboseRaw}`.
3. **`tool_result` arrives.** Handler in `app.go`:
   - Clears thinking spinner; commits any in-flight streaming card to scrollback.
   - Calls `FormatCompactToolLine` for the compact representation + status flags.
   - Picks prefix glyph: `✗` (error), `⚠` (denied), or none.
   - Branches on `m.toolOutputMode`:
     - `compact` → `m.print(prefix + line + chevron)`
     - `detailed` → builds `ToolCard` with `InlineLines: m.toolOutputInlineLines`, `m.print(card.View(width))`
   - If `m.verboseRaw` → `m.print(rawOutputBlock)` after the rendered line/card.
   - Appends `CompletedBlock` to ring buffer (unchanged from today).
4. **`/expand N`** continues to work as today — reads the ring buffer and renders the Nth-most-recent tool's raw payload below the prompt.

## Error handling

The wire `ToolResult` event (`packages/tui/internal/transport/types.go:81-90`) doesn't carry an explicit `isError` field; status info is buried in `Output`. The TS-side `src/core/orchestrator.ts` deny branch emits Anthropic-shaped `{type:'tool_result', content:'permission denied: <reason>', is_error:true}`, while tool failures emit a JSON envelope with `status:'error'` inside `Output`. Detection on the Go side:

```go
func detectStatus(output json.RawMessage) (isError, isDenied bool) {
    var env struct{ Status, Summary string }
    if err := json.Unmarshal(output, &env); err == nil && env.Status == "error" {
        return true, false  // runtime tool error
    }
    raw := strings.TrimSpace(string(output))
    raw = strings.TrimPrefix(raw, `"`)
    if strings.HasPrefix(raw, "permission denied") {
        return true, true  // permission denied
    }
    return false, false  // success (or status omitted — treat as success)
}
```

This is robust against both shapes seen on the wire today. If the orchestrator path changes or a future tool emits an unexpected shape, the worst case is a missed glyph — the line still renders correctly with a fall-through "success" presentation.

**Future-proofing path** (out of scope for this milestone): add explicit `isError bool` and `isDenied bool` fields to the SSE `ToolResult` envelope. Detection becomes trivial. Punted until/unless this milestone's detection proves fragile in practice.

## Per-tool compact format

| Wire tool | Compact line | Source fields |
|---|---|---|
| `FileRead` | `Read <path>` | `input.path` |
| `FileWrite` | `Wrote <path>` | `input.path` |
| `FileEdit` | `Edited <path> +<add> -<del>` | `input.path` + parse Output for diff stats |
| `Bash` | `Ran $ <description-or-truncated-command>` | `input.description ?? input.command`, truncated to ~50 chars |
| `Grep` | `Grep '<pattern>'` (+ ` in <path>` if scoped) | `input.pattern`, `input.path` |
| `Glob` | `Glob '<pattern>'` (+ ` — N matches` when extractable) | `input.pattern`, count from `output` |
| `WebFetch` | `Fetched <host><first-path-segment>` | `input.url`, truncated to host + first path segment + `…` |
| `WebSearch` | `Web search '<query>'` | `input.query` |
| `MemoryRead` | `Read memory <file>` | `input.file` |
| `MemoryWrite` | `Wrote memory <file>` | `input.file` |
| `MemoryEdit` | `Edited memory <file>` | `input.file` |
| `MemoryPropose` | `Proposed memory '<name>'` | `input.name` |
| `SkillPropose` | `Proposed skill '<name>'` | `input.name` |
| MCP (any tool prefixed `mcp__<server>__<tool>`) | `<server>: <tool> <input-preview>` | derive server + tool from name; input flattened to single line |
| Unknown | `<ToolName>` + first 40 chars of input | fallback |

**Truncation policy:** total rendered line ≤ `width - 4`. Verb + target preserved; stats clipped first, then target with ellipsis. Single-line guarantee — newlines in any extracted value flatten to spaces.

## Visual examples

Compact mode (default):
```
› fix the build

Read build.log                                         ›
Edited build.ts +3 -1                                  ›
Ran $ bun run build                                    ›
✗ Bash $ bun run test                                  ›
⚠ Edit src/server/server.ts                            ›

  Looks like one test is failing due to a missing import.
  …
```

Detailed mode (`ui.toolOutput.mode = 'detailed'`):
```
› fix the build

╭ Read                                                   ╮
│ build.log                                              │
│ [first 10 lines of file]                               │
│ …[+42 more lines]                                      │
╰────────────────────────────────────────────────────────╯

╭ Edited build.ts +3 -1                                 ╮
│ [diff hunks — DiffView, unchanged from today]         │
╰────────────────────────────────────────────────────────╯
```

`-v / --verbose` flag (orthogonal — appended below either mode):
```
Edited build.ts +3 -1                                  ›
  [full untruncated diff and tool output, dim/indented]
```

## Testing

Unit + integration coverage across TS and Go:

**Go — `packages/tui/internal/components/compactline_test.go` (NEW, ~20 tests):**
- One happy-path test per wire tool name (15+ cases). Each asserts the exact rendered line.
- 3 status variants — success / `status:'error'` envelope / bare `permission denied:` text — assert `(isError, isDenied)` return.
- 2 truncation tests — short input (verbatim) / very long input (ellipsis applied, line fits width).
- 2 stat-extraction tests for FileEdit — diff with `+3 -1`, empty diff (renders `Edited path` without stats).
- 1 MCP fallback test — `mcp__notion__create-page` formats correctly.
- 1 unknown-tool fallback test — `SomeNewTool` renders verb-less with input preview.

**Go — `packages/tui/internal/components/toolcard_test.go` (additions):**
- 1 test for `InlineLines: 5` truncation + `…[+N more lines]` footer.
- 1 test for `InlineLines: 0` header-only rendering.

**Go — `packages/tui/internal/render/code_test.go` (addition):**
- 1 test asserting `chromaStyleForTheme(...)` returns `monokai` for non-light themes.
- 1 test asserting `catppuccin-latte` for the light theme (regression guard).

**Go — `packages/tui/internal/app/app_test.go` (additions, ~4 tests):**
- 1 test for compact-mode `tool_result` handler — asserts scrollback contains one compact line, no bordered card.
- 1 test for detailed-mode handler — asserts bordered card with truncation.
- 1 test for `-v / --verbose` orthogonal raw output appended below compact line.
- 1 test for the prefix glyph selection (`⚠` for denied, `✗` for error, none for success).

**TS — `tests/config/schema.test.ts` (additions):**
- 1 test for `mode: 'compact'` parses.
- 1 test for `mode: 'detailed'` parses.
- 1 test for `mode: 'invalid'` rejects.

**TS — `tests/cli/tuiLauncher.test.ts` (additions):**
- 1 test asserting nothing is written to stderr at boot (regression guard for Fix A).
- 1 test asserting the launcher forwards `--tool-output-mode` and `--tool-output-inline-lines` flags from the config snapshot.
- 1 test asserting `-v` forwards as `--verbose-raw`.

Total: ~28 new tests across the codebase. All testable without an LLM (mechanical, deterministic). The existing suite (TS 1972/0/14, Go all green) stays green.

## Rollout

Single PR. No phased deployment. Phase 16.1 is closed; this is post-close-out polish like ux-fixes rounds 3-5.

After merge:
- Run `sov upgrade` to pick up the new binary (per the standing convention in `docs/05-conventions/sov-upgrade.md`).
- Default behavior changes to compact mode immediately. Users wanting the prior bordered-card behavior set `ui.toolOutput.mode: 'detailed'` via `sov config`.

## Postmortem-rule compliance check

The Phase 16.1 revert's Rules 1-4 (`docs/07-history/postmortems/2026-05-12-phase-16-revert.md`) apply primarily to foreground-surface refactors with active downstream consumers. This work is single-user UX polish, not a published-API change.

- **Rule 1 (deprecation soak)** — Waived. No downstream consumers; the user is the only consumer.
- **Rule 2 (no helper deletion without consumer audit)** — Satisfied. `ToolCard` keeps the same exported signature (new optional `InlineLines` field is additive). `chromaStyleForTheme` keeps the same signature. The stderr line at `tuiLauncher.ts:293` is a `process.stderr.write` with no callers.
- **Rule 3 (independent re-audit before claiming done)** — Will be satisfied via a parallel Explore agent at close-out, auditing every TUI doc + a manual smoke pass through both modes on real Anthropic.
- **Rule 4 (escape hatch during transition)** — Satisfied. `ui.toolOutput.mode: 'detailed'` is the escape back to the old card behavior. `-v / --verbose` is the escape to raw output. Both are documented.

## Open questions

None remaining at spec time. All seven brainstorm questions resolved.

## See also

- `docs/05-conventions/tui-color-rendering.md` — body text inherits terminal default. The chevron + glyphs use accent colors per this rule.
- `docs/05-conventions/tui-ux-patterns.md` — flow layout, splash, spinner, tool events. Update after merge to reflect compact-mode tool rendering.
- `docs/07-history/state/2026-05-21-ux-fixes-r5.md` — round 5 architectural pivot (inline mode, no alt screen) that this work builds on.
- `docs/07-history/state/2026-05-22-phase-21-m1.md` — current canonical state snapshot.
- `packages/tui/internal/components/toolcard.go` — current bordered-card renderer (detailed mode).
- `packages/tui/internal/components/liveregion.go` — bottom-anchored live region (in-flight feedback).
- `packages/tui/internal/render/code.go` — chroma style selection.
- `src/cli/tuiLauncher.ts` — TS-side spawn + flag forwarding + the stderr line being removed.
- `src/config/schema.ts` — `userSettings.ui.toolOutput` schema being extended.
- `src/core/orchestrator.ts` — deny branch that emits `permission denied: ...` content.
