# Phase 16.1 — TUI Rebuild · Design Spec

Status: **draft** — pending user review before implementation plan is written
Created: 2026-05-13
Supersedes: the Phase 16.1 section of `specs/2026-05-13-production-harness-roadmap-design.md` (umbrella roadmap). Phase 14 (Distribution & Public Docs) is dropped from the roadmap — this harness is proprietary, distribution is deferred until product is production-grade.
Authority: enforces Rules 1–4 of `docs/07-history/postmortems/2026-05-12-phase-16-revert.md`.

---

## 1. Purpose

Build a polished, daily-driver TUI that wins on the same surface area as Claude Code at visibly higher quality. The TUI is the new default foreground for `sov` once it clears a parity audit against the existing `terminalRepl.ts`. Until then, both surfaces coexist — `--ui repl` (default) and `--ui tui` (opt-in) — per Postmortem Rule 1.

The differentiation axis is **polish craft**: smoother streaming, prettier tool cards, syntax-highlighted inline diffs with hunk navigation, fuzzy slash-command autocomplete with description preview, persistent always-visible status line, mouse support, light/dark plus user-loadable themes. The TUI does **not** add feature surface area beyond what `terminalRepl.ts` already supports — no session browser, no command palette, no multi-pane layouts, no image rendering, no vim keybindings. Those are explicitly deferred (see §11).

---

## 2. Goal

When this phase completes:

1. `sov` launches into the new TUI by default. `sov --ui repl` reaches the legacy readline surface as an escape hatch.
2. The TUI renders: streaming assistant text with markdown + syntax-highlighted code, collapsible tool-use cards with per-tool result rendering, inline diffs for `FileEdit` / `FileWrite` with `j`/`k` hunk navigation, slash-command autocomplete with fuzzy match + description preview, centered permission-prompt modal, fixed bottom-anchored input row, fixed bottom-anchored status line (cwd / profile / provider / model / cost / cache-hit / streaming indicator), mouse scroll + click-to-focus, light + dark themes plus user themes loaded from `~/.harness/themes/*.toml`, goodbye summary on `/quit`.
3. All 24 subsystems enumerated in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` are wired and verified against the TUI at parity with `terminalRepl.ts`.
4. The full semantic suite passes on both surfaces with an identical pass set.
5. The architectural separation it introduces (HTTP+SSE backend, separate TUI client process) becomes the foundation for later phases: HTTP API consumers (the canonical Phase 18 work, partially absorbed here), MCP server mode (Phase 19), and any future IDE/web frontends.

---

## 3. Decisions Locked In This Spec

Recorded as ADR stubs in `DECISIONS.md` once spec is approved.

1. **Architecture: split process.** `sov` (TS, Bun) runs the agent and an HTTP+SSE server. `sov-tui` (Go binary, Bubble Tea) is a separate process and connects over `localhost`. Rationale: best polish ceiling on terminal UIs (Bubble Tea is the mature stack — opencode, k9s, lazygit, gh CLI's interactive surface, Charm's products); same backend later serves IDE plugin, web UI, channel adapters without rework; crash-isolation between renderer and runtime; disconnect/reattach is essentially free.
2. **TUI framework: Go + Bubble Tea.** Charm stack: `bubbletea`, `lipgloss`, `bubbles`, `glamour`, `chroma`. opencode's choice; the most mature TUI ecosystem in any language.
3. **Differentiator: polish craft.** Win on Claude Code's surface area at visibly higher quality. Out-of-scope: feature expansion beyond CC's surface (see §11).
4. **Layout: anchored bottom chrome.** Viewport for transcript fills available height; fixed input row above; fixed status row below it. Both chrome rows stay visible during transcript scrollback. Selected over CC-style floating-inline input and over editor-style top-status during 2026-05-13 brainstorming.
5. **Binary delivery: postinstall `go build`.** `package.json` postinstall hook runs `go build ./packages/tui/cmd/sov-tui` after `bun install -g`. Go 1.22+ prerequisite documented. Build failure prints clear remediation and `sov` falls back to `--ui repl` with a one-line warning until fixed.
6. **terminalRepl coexists through M11.** Rule 1 of the Phase 16 revert postmortem: never delete a working foreground surface in the same series that builds a new one. Deprecation warning at M12; removal ≥2 releases later.
7. **Transport: HTTP + SSE.** Not WebSocket. Bun + Hono on the server side; standard `net/http` + JSON-line SSE parsing on the Go client side. Bind to `127.0.0.1` only in v1; no auth (security model documented).
8. **Open Q1 from the umbrella roadmap (TUI framework) is now CLOSED** with the answer above. Open Q2 (provider strategy for Phase 15) remains open and is unrelated to this phase.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  sov  (TS / Bun)                                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  query()  ──►  StreamEvent generator                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│       │                                                        │
│       ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Hono server  (src/server/)                              │  │
│  │  binds 127.0.0.1:<random>                                │  │
│  │                                                          │  │
│  │   POST   /sessions                  create               │  │
│  │   GET    /sessions/:id/events       SSE stream           │  │
│  │   POST   /sessions/:id/turns        submit turn          │  │
│  │   POST   /sessions/:id/approvals/:requestId   permission │  │
│  │   GET    /sessions/:id              metadata             │  │
│  │   GET    /commands  /tools  /providers  /health          │  │
│  └──────────────────────────────────────────────────────────┘  │
│       │                                                        │
│       │   spawns                                               │
└───────┼────────────────────────────────────────────────────────┘
        ▼
┌────────────────────────────────────────────────────────────────┐
│  sov-tui  (Go / Bubble Tea)                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  SSE consumer (tea.Cmd)  ──►  typed tea.Msg               │  │
│  └──────────────────────────────────────────────────────────┘  │
│       │                                                        │
│       ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  App  (Elm Model/Update/View)                            │  │
│  │  Transcript · Prompt · StatusLine · ToolCard ·           │  │
│  │  DiffView · Permission · SlashAutocomplete · Themes      │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

`sov` always runs the server. When the user runs `sov --ui tui` (or after M11, bare `sov`), the parent process picks a free localhost port, spawns `sov-tui` as a child with `--session-id <id> --port <p>`, and the child connects via SSE. The parent process's stdout/stderr is the TUI's stdout/stderr — Bubble Tea owns the terminal.

`sov --ui repl` is unchanged. terminalRepl imports the runtime directly and never touches the HTTP server.

`sov dispatch` is unchanged. It is a third foreground surface for headless slash-command regression testing, and continues to use a different code path (no server, no TUI).

---

## 5. Backend (`src/server/`)

**Stack.** Hono 4.x on Bun. Bun's native `Bun.serve` would also work but Hono provides routing ergonomics, middleware shape that downstream Phase 18 expansion will lean on, and matches the opencode pattern.

**Module layout.**

```
src/server/
  app.ts                  // Hono app construction
  routes/
    sessions.ts           // POST /sessions, GET /sessions/:id
    events.ts             // GET /sessions/:id/events (SSE)
    turns.ts              // POST /sessions/:id/turns
    approvals.ts          // POST /sessions/:id/approvals/:requestId
    commands.ts           // GET /commands
    tools.ts              // GET /tools
    providers.ts          // GET /providers
    health.ts             // GET /health
  sseStream.ts            // async-generator → SSE adapter
  schema.ts               // Zod schemas for events + request bodies
  approvalQueue.ts        // permission_request → POST /approvals roundtrip
  port.ts                 // free-port discovery on 127.0.0.1
  index.ts                // export startServer(opts): Promise<{ port, stop }>
```

**Lifecycle.** `startServer({ profile, agent, provider?, model?, captureFile?, replayFile?, ... })` returns a `{ port, stop() }` handle. The server holds in-memory references to the in-process agent context (session DB, tool pool, permission registry, MCP clients, sub-agent scheduler, etc. — all constructed exactly as `terminalRepl` constructs them, factored into `src/cli/runtimeContext.ts` if not already extractable). One server per `sov` process. Single-session active in v1; multi-session is supported by the schema but not by v1 UX.

**SSE event types.** Each event has `{ type, seq, sessionId, ...payload }`. `seq` is monotonic per session. Bun's `Bun.serve` SSE response handler reads `Last-Event-ID` header on reconnect and replays from the server-side ring buffer.

| Event type | Payload | Notes |
|---|---|---|
| `text_delta` | `{ block, text }` | streaming assistant text |
| `thinking_delta` | `{ block, text }` | extended-thinking blocks |
| `tool_use_start` | `{ block, tool, inputPartial }` | tool call begins; inputPartial may be empty |
| `tool_use_input_delta` | `{ block, delta }` | streamed JSON delta of input |
| `tool_use_done` | `{ block, input }` | input finalized |
| `tool_result` | `{ block, tool, input, output, renderHint, language? }` | see §7 |
| `permission_request` | `{ requestId, tool, input, reason }` | server-side promise pauses turn until POST /approvals resolves |
| `status_update` | `{ cost, tokensIn, tokensOut, cacheHitRate, streaming }` | emit on token-count changes; throttled to ~10 Hz |
| `turn_complete` | `{ usage, finishReason }` | end of a turn |
| `turn_error` | `{ error, recoverable }` | non-fatal error during a turn |
| `session_resumed` | `{ resumedFromSeq }` | sent on reconnect after `Last-Event-ID` |

**Ring buffer.** Per-session in-memory ring of the last N events (default N=2048) for replay on reconnect. Eviction = drop oldest. Reconnecting client whose `Last-Event-ID` is older than the oldest retained seq receives a `session_resumed` with `resumedFromSeq: 0` and a fresh transcript fetched from session DB.

**Permission round-trip.** When `canUseTool` returns `behavior: "ask"`, the server creates a `requestId`, emits `permission_request`, and `await`s a `Promise` keyed by `requestId`. `POST /sessions/:id/approvals/:requestId` with `{ approved: true|false, updatedInput? }` resolves the promise. Timeout 60s by default (configurable); on timeout, deny.

**Auth.** None in v1. Server refuses to bind to anything other than `127.0.0.1`. Documented as the v1 security boundary in `docs/03-cli-reference/usage.md`. OAuth/token auth deferred to the eventual remote-serve work (Phase 18 expansion or later).

**Tests.** `tests/server/` — endpoint integration tests with an in-process Hono test client. SSE event-stream assertions for the common paths. No external network.

---

## 6. Foreground (`packages/tui/`)

**Stack.** Go 1.22+. Modules: `github.com/charmbracelet/bubbletea` (Elm-style Model/Update/View), `github.com/charmbracelet/lipgloss` (layout + styling), `github.com/charmbracelet/bubbles` (textinput, viewport, spinner, key bindings), `github.com/charmbracelet/glamour` (markdown rendering with ANSI), `github.com/alecthomas/chroma/v2` (syntax highlighting for code blocks and diffs).

**Module layout.**

```
packages/tui/
  go.mod
  cmd/sov-tui/
    main.go                  // entry; parses --port, --session-id; calls app.Run()
  internal/
    app/
      app.go                 // Model, Update, View; root component
      keys.go                // key bindings
    transport/
      sse.go                 // SSE consumer; emits typed tea.Msg
      api.go                 // POST /turns, POST /approvals; thin HTTP client
      types.go               // event types mirroring src/server/schema.ts
    components/
      transcript.go          // scrollable viewport of user/assistant/tool cards
      prompt.go              // textinput with history, multi-line, autocomplete trigger
      statusline.go          // bottom status row
      toolcard.go            // collapsible input + output renderer dispatch
      diffview.go            // inline diff with hunk-nav
      permission.go          // centered modal overlay
      slashautocomplete.go   // popup; fuzzy match against /commands
      goodbye.go             // exit summary
    render/
      markdown.go            // glamour wrapper, themed
      code.go                // chroma wrapper, themed
      diff.go                // diff hunk parser + chroma highlighter
      text.go                // plain-text renderer (fallback)
      table.go               // table renderer for renderHint=table
      tree.go                // tree renderer for renderHint=tree
      json.go                // pretty JSON for renderHint=json
    theme/
      theme.go               // Theme struct + Apply(lipgloss styles)
      light.go               // built-in light theme
      dark.go                // built-in dark theme
      loader.go              // TOML loader for ~/.harness/themes/*.toml
```

**Boot.** `main.go`: parse flags → connect to `http://127.0.0.1:<port>/sessions/<id>/events` → if SSE handshake fails, print a clear error and exit non-zero so parent can fall back to terminalRepl.

**Model.** Single root model. State: connected session metadata, message list, pending tool calls, current input text, scroll offset, modal stack (permission prompt, slash autocomplete, theme picker), active theme, status fields.

**Update.** Receives `tea.Msg`s from: (a) the SSE consumer (one msg per event), (b) `bubbles/textinput` key events, (c) viewport key/mouse events, (d) the API client (success/error of POSTs). Dispatches to component update functions.

**View.** Composes: top spacer → transcript viewport → input prompt row → status line. Overlays (permission modal, slash autocomplete) rendered with lipgloss `Place` to center on the layer above.

**Streaming.** `text_delta` events append to the current assistant card's text buffer. The transcript re-renders only the last card during streaming (avoid full redraw). `glamour` does not stream natively — workaround is to re-render the entire current message on each delta with a small debounce (~16ms) to avoid jitter.

**Mouse.** Bubble Tea v2 native mouse support: scroll-wheel → viewport scroll; click-on-input → focus textinput; click-on-tool-card → toggle collapse.

**Themes.** `theme.Theme` is a struct of lipgloss styles. Light + dark built in. TOML loader reads `~/.harness/themes/*.toml`; `/theme <name>` switches active theme; theme survives session reload via `~/.harness/config.json`.

**Tests.** `packages/tui/internal/**_test.go` — Go test framework. `teatest` (Charm's official Bubble Tea test harness) for snapshot tests of rendered output. Theme loader tests against fixture TOML.

---

## 7. Tool Renderer Bridge

Existing Sov tools expose `renderToolUseMessage(input, ctx)` and `renderToolResultMessage(result)` returning ANSI strings designed for readline. The Go TUI cannot call TS render methods.

**Solution.** Add `renderHint` to each `Tool<I, O>` declaration. Discriminated string union:

```ts
type RenderHint =
  | { kind: 'text' }
  | { kind: 'markdown' }
  | { kind: 'code'; language?: string }
  | { kind: 'diff'; language?: string }
  | { kind: 'table'; columns?: string[] }
  | { kind: 'tree' }
  | { kind: 'json' };
```

`tool_result` events on the SSE bus carry `{ tool, input, output, renderHint, language? }`. The Go TUI's `render/` package dispatches on `renderHint.kind`. Default fallback for unhinted tools: `text`.

Per-tool hint assignments (representative subset; full assignment lands in M3):

| Tool | renderHint |
|---|---|
| `FileRead` | `code` with detected language from extension |
| `FileWrite` / `FileEdit` | `diff` with detected language |
| `Bash` | `text` (or `code` if shell output starts with shebang detection) |
| `Glob` / `Grep` | `tree` (file listings) |
| `WebFetch` | `markdown` (most fetched pages are HTML→markdown'd) |
| `WebSearch` | `tree` (result listing) |
| `MemoryTool` / `MemoryProposeTool` | `markdown` |
| `SkillManageTool` | `markdown` |
| `Task*` family | `table` |
| `HarnessInfo` | `markdown` |
| `ToolSearchTool` | `tree` |
| MCP tools (`mcp__*`) | `text` default; per-server override allowed |

**Net add.** ~50 LoC across the tool pool to attach hints. Existing TS render methods are preserved and continue to drive `terminalRepl`. The Go TUI uses the hint; the TS REPL uses the legacy renderer.

---

## 8. Build & Distribution

**Postinstall hook.** `package.json`:

```json
{
  "scripts": {
    "postinstall": "bun run scripts/build-tui.ts"
  }
}
```

`scripts/build-tui.ts` does:

1. Check `go` is on PATH and `go version` reports ≥ 1.22. If not, print a clear remediation block (where to install Go on macOS / Linux) and exit non-zero with a final `console.log("sov TS runtime installed but TUI was not built. Use 'sov --ui repl' for now; reinstall after installing Go.")`.
2. `cd packages/tui && go build -o ../../bin/sov-tui ./cmd/sov-tui`.
3. Verify the binary runs with `sov-tui --version`; if not, exit non-zero with the same message.

**Path resolution.** The TS-side spawn code resolves `sov-tui` by:

1. `process.env.SOV_TUI_BIN` if set (dev override).
2. `<repo-root>/bin/sov-tui` next to the `sov` entrypoint.
3. `PATH` lookup as a final fallback.

If none resolve, `sov` defaults to `--ui repl` with a one-line warning at startup. This is the same fallback path used when postinstall fails.

**Cross-platform.** `go build` for the host platform only. macOS (arm64 / x64), Linux (x64 / arm64). Single user, single platform per install — no cross-compilation in v1.

**`sov upgrade`.** Existing `sov upgrade` runs `bun install -g git+ssh://...`. With the postinstall hook in place, upgrades automatically rebuild the Go binary. No new flag or step.

---

## 9. 24-Prereq Wiring Strategy

`docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` enumerates 24 subsystems that any new foreground must wire. Postmortem Rule 1: never delete terminalRepl; both surfaces stay alive in parallel. Postmortem Rule 3: audit "silently broken" surfaces before declaring a phase complete.

**Strategy.**

1. Each subsystem is wired in a numbered milestone. No batching across coherent groups.
2. Each milestone closes with: (a) the prereq doc's checkbox for that row flipped to `[x]`, (b) a green semantic-suite run with `--surface tui` filter against the wired surface, (c) an entry in `docs/06-testing/testing-log.md`.
3. terminalRepl is untouched from M0 through M11. M10 (parity audit) runs the full semantic suite on both surfaces and requires an identical pass set. M11 flips the default to `tui` only after M10 sign-off.
4. terminalRepl removal scheduled ≥2 releases after M11 (M12 = deprecation warning sustained across ≥2 releases; M13 = removal).
5. No helper module of terminalRepl (`src/commands/*`, `src/ui/terminalRepl.ts`, etc.) is deleted or modified through M11. The TUI's wiring touches only its own surface and the new server module.

**Groups (from `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`).**

| Group | Milestone | Subsystems |
|---|---|---|
| Critical correctness | M4 | session DB persistence; preflight checks; CLI flag forwarding |
| User-noticed | M5 | hooks (PreToolUse/PostToolUse/Stop); permission modal; sub-agent scheduler |
| Long-session survival | M6 | compactor; microcompaction; context-overflow recovery |
| Hermes-layer parity | M7 | MCP client pool; TaskManager construction; trace writer; trajectory capture; learning observer; review manager |
| Polish surfaces | M8 | local-model router; capture/replay; `@file:path` expansion; subdirectory hints; skill-as-slash-command; skill visibility filtering; goodbye summary; stall detection; tool-result expand registry |

24 rows = 3 + 3 + 3 + 6 + 9. Matches the prereq doc's enumeration.

---

## 10. Milestone Sequence

Each milestone closes with: spec/CLAUDE.md/state-snapshot update if applicable, prereq checkbox(es) flipped, testing-log entry, commit + push, `sov upgrade` if runtime-affecting.

| Milestone | Goal | Exit criteria |
|---|---|---|
| **M0** | Spec landed; ADRs recorded | This doc committed; ADR stubs in `DECISIONS.md`; umbrella roadmap updated (drop Phase 14, renumber sequencing) |
| **M1** | Hono server skeleton | `/health` returns 200; SSE endpoint emits a hardcoded `text_delta` stream end-to-end; unit tests for routing |
| **M2** | Bubble Tea bare scaffold | `sov-tui` binary builds; connects to a running `sov serve`-equivalent dev harness; renders hardcoded transcript + status line; ESC quits; `--ui tui` flag (opt-in) lands in `src/main.ts` |
| **M3** | One real turn end-to-end | `query()` wired through the server; one real turn renders in TUI; tool-use renders as placeholder card; `renderHint` field added to every tool in the pool; no subsystems yet (deliberately bare) |
| **M4** | Critical correctness group | Session DB persistence; preflight checks; CLI flag forwarding (every flag accepted by `sov chat`/`sov` reaches TUI with identical semantics); 3 prereq boxes flipped |
| **M5** | User-noticed group | Hooks fire around tool calls; permission modal replaces readline asker; sub-agent scheduler honored (per-lane semaphores, write-lock, per-child timeout); 3 more boxes flipped |
| **M6** | Long-session survival group | `/compact` works; threshold-triggered compaction works; microcompaction (per-part tool-result clearing); context-overflow → `createClearedChildSession`; 3 more boxes |
| **M7** | Hermes-layer parity group | MCP client pool; TaskManager; trace writer; trajectory capture (ShareGPT-shaped, redacted at write); learning observer; review manager; 6 more boxes |
| **M8** | Polish-surfaces group | Local-model router; capture/replay; `@file:path` expansion; subdirectory hints; skill-as-slash-command; skill visibility filtering; goodbye summary; stall detection; tool-result expand registry; 9 more boxes — 24/24 |
| **M9** | Visual polish | `glamour` markdown rendering; `chroma` syntax highlighting on code + diffs; inline diff hunk nav (`j`/`k`); slash autocomplete popup with fuzzy match + description preview; mouse scroll + click-to-focus; theme system (light + dark + TOML loader for user themes); status-line live cost + cache delta + streaming indicator |
| **M10** | Parity audit | All 24 boxes are `[x]`; full semantic suite run on both `--ui repl` and `--ui tui` produces identical pass set; 7-agent REPL soak shows no regressions vs terminalRepl baseline; signed-off report at `docs/07-history/state/<date>-tui-parity-audit.md` |
| **M11** | Default flip | `--ui` default → `tui`; `--ui repl` remains an escape hatch; `CHANGELOG.md` entry; release tagged |
| **M12** | terminalRepl deprecation | `--ui repl` prints a deprecation warning on launch; warning includes the planned removal version |
| **M13** | terminalRepl removal | After ≥2 releases at M12, terminalRepl + helpers are removed; `--ui repl` errors with migration instructions |

Estimated effort (with AI-pair throughput, single developer, milestone-by-milestone state snapshots):

| Milestones | Wall estimate |
|---|---|
| M0–M3 (server skeleton + bare TUI + one real turn) | 2–3 weeks |
| M4 (critical correctness, 3 boxes) | ~1 week |
| M5 (user-noticed, 3 boxes) | 1–2 weeks |
| M6 (long-session, 3 boxes) | ~1 week |
| M7 (Hermes-layer, 6 boxes — hardest group) | 2–4 weeks |
| M8 (polish surfaces, 9 boxes) | 2–3 weeks |
| M9 (visual polish) | 1–2 weeks |
| M10–M11 (parity audit + flip) | 1–2 weeks |

Total: **11–18 weeks** to M11 (default flip). M12 deprecation period and M13 removal extend beyond this.

---

## 11. Out Of Scope (Explicit, Deferred)

Not in v1. Each is a candidate for a later sub-phase if user demand surfaces.

- Session browser / picker (only the current session is visible).
- Command palette (cmd-K).
- In-transcript search.
- Multi-pane layouts beyond transcript + input + status (no sidebar, no file tree, no separate diff pane — diffs render inline).
- Image rendering (sixel, kitty, iTerm2 inline images).
- Vim keybindings.
- Concurrent session tabs.
- OAuth / token auth on the server.
- Remote / non-localhost serving (the server binds to `127.0.0.1` only).
- Web frontend.
- IDE extensions (VS Code, Zed, JetBrains).

The split-process architecture makes most of these mechanically feasible later — the server contract is the foundation. They are deferred for scope, not architecturally precluded.

---

## 12. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Plumbing-lift recurrence (Phase 16.0b/c failure mode) | medium | Opt-in `--ui tui` through M10; terminalRepl untouched through M11; 24-prereq checkbox-gate; M10 requires identical semantic-suite pass set on both surfaces before flip |
| Go/TS cross-language friction | low–medium | Thin Go client (no business logic); single boundary protocol (SSE+JSON); Go types generated from `src/server/schema.ts` via codegen step at M1 |
| Renderer fidelity gap between TS readline render and Go TUI render | medium | `renderHint` pattern with per-tool declarations reviewed in M3; fixture-corpus comparison at M10 (same input rendered on both surfaces, diff'd against a tolerance threshold) |
| `sov-tui` postinstall build failure on a user's machine | low (single-customer regime) | Clear Go-install error message; automatic fallback to `--ui repl`; documented in `docs/03-cli-reference/usage.md` |
| `glamour` performance on long streaming deltas | medium | Debounce re-render on `text_delta` to ~60 Hz; only re-render the current assistant card, not the full transcript; benchmark in M9 with a 50KB streamed response |
| Bubble Tea Elm-loop incompatibility with the async-generator runtime | low | The async-generator lives entirely on the TS side; the Go side only consumes typed SSE events; the boundary is the SSE protocol, designed to fit Elm's `Cmd`/`Msg` shape natively |
| SSE proxy buffering | n/a in v1 | Localhost-only; no proxy concerns. Defer to remote-serve phase |
| Theme TOML format churn | low | Versioned theme files (`version = 1` at top); loader rejects unknown versions with a clear message; v1 schema documented in `docs/03-cli-reference/usage.md` |
| Postinstall hook breaks existing dev installs | low | Postinstall lands at M1 alongside the server; pre-M1 the hook is a no-op; existing dev installs `bun upgrade` to pick it up; documented in `docs/07-history/state/<M1-date>.md` |

---

## 13. Open Questions Deferred To Implementation Plan

These are decided at plan-writing time, not in this spec. Each lands as a small inline decision in the implementation plan rather than a separate brainstorming pass.

- Exact event payload shapes (Zod schemas in `src/server/schema.ts`).
- Exact key bindings (Bubble Tea convention preferred; `?` opens a help overlay).
- Exact theme TOML schema (color slot names, gradient stops, etc.).
- Exact status-line visual rhythm (separator characters, spacing, animation).
- Slash-autocomplete fuzzy-match algorithm choice (`sahilm/fuzzy` is the default Go choice; verify against `COMMAND_REGISTRY` size).
- Whether `bubbles/help` is used for the help overlay or a custom component (default: `bubbles/help`).
- Sub-agent activity surfacing — does the TUI show a small "1 sub-agent running" indicator in the status line? (M5 decision; default: yes, minimal indicator).
- Whether status-line live cost is computed server-side and pushed via `status_update` or computed client-side from `turn_complete.usage` (M9 decision; default: server-side push for liveness during streaming).

---

## 14. Integration With The Umbrella Roadmap

`specs/2026-05-13-production-harness-roadmap-design.md` is the umbrella roadmap. Required edits, executed in a follow-up commit:

1. **Drop Phase 14 entirely.** Rationale: this harness is proprietary, distribution is deferred until the product is production-grade. Remove the Phase 14 section, remove Phase 14 from §5 phase-map and §10 sequencing tables, remove Phase 14 from §9 integration with canonical build plan.
2. **Update Phase 16.1 section to point at this spec.** The current §7 Phase 16.1 block in the umbrella becomes a short summary with a link here.
3. **Renumber dependencies.** Phase 15 (provider breadth) no longer blocks on Phase 14; Phase 16.1 no longer requires Phase 14's distribution work as a prerequisite. Phase 21 (plugin SDK + IDE extensions) loses its Phase 14 dependency edge.
4. **Resequence: 16.1 is now next.** Per user direction (2026-05-13): "let's move to 16.1." The new sequencing makes 16.1 the immediate next phase. Phase 15 (provider breadth) is deferred to run after 16.1 or in parallel — user's call at 16.1 plan kickoff. Update §5 phase-map status column and §10 sequencing accordingly. The parallel-safe ordering becomes: **Track A** = 16.1 → 18 → 19 → 21; **Track B** (parallel-safe with 16.1's later milestones) = 20 (LSP) and 15 (providers) in whichever order user prefers.
5. **Update §6 Open Q1 status.** Mark Open Q1 (TUI framework) as CLOSED with the answer "Go + Bubble Tea (split-process)" and a cross-reference to this spec.
6. **Update CLAUDE.md Phases section** to point at this spec as the active forward-looking plan and indicate Phase 16.1 is the next phase to execute (Phase 15 deferred or run in parallel at user's call).
7. **Add ADR stubs to `DECISIONS.md`** for the eight locked decisions in §3.

The follow-up commit is mechanical and lands after the user approves this spec.

---

## 15. Self-Review

**Placeholder scan.** No "TBD", "TODO", "fill in later", or "implement later" remain in the spec body. All filenames and paths are concrete. All recommended packages are named.

**Internal consistency.** §4 (architecture) matches §5 (backend), §6 (foreground), §7 (renderer bridge). The 24 prereqs in §9 sum to 24 (3+3+3+6+9). The milestones in §10 reference the correct groups. The deferred items in §11 do not contradict §2 (goal).

**Scope check.** Single phase, single foreground rebuild, anchored to one architectural decision (split process) and one differentiator (polish craft). Implementation will fit a single multi-milestone plan; no decomposition needed at the spec level.

**Ambiguity check.** Tool renderer bridge (§7) is the most ambiguity-prone area — the `renderHint` discriminated union is fully specified and the per-tool table is concrete. Permission round-trip (§5) names the timeout (60s default, configurable) and the deny-on-timeout default. Build path resolution (§8) names the three lookup steps in order.

**Decision traceability.** Each of the eight locked decisions in §3 is traceable to a question asked during 2026-05-13 brainstorming. Each Open-Q-deferred item in §13 is genuinely a detail for the plan, not a load-bearing architectural choice masquerading as an implementation detail.

---

## 16. Next Steps

1. User reviews this spec.
2. On approval: commit this spec; execute the umbrella-roadmap edits in a follow-up commit; add ADR stubs to `DECISIONS.md`.
3. Invoke `superpowers:writing-plans` to produce `plans/2026-05-13-phase-16-1-tui-rebuild.md` — a TDD task-by-task implementation plan for milestones M0 through M3 (the bare-scaffold + first-real-turn arc). Subsequent milestones (M4–M13) get their own plans as they come up; no plan is multi-month.
