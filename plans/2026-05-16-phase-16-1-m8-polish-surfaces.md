# Phase 16.1 M8 — Polish-Surfaces Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent model policy: Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; never Haiku (see `docs/05-conventions/subagent-policy.md`).

**Goal:** Wire nine subsystems into Phase 16.1's split-process architecture so the server-side runtime reaches feature parity with `terminalRepl.ts` on the user-facing polish surfaces: **local-model router** (server-side `RouterProvider` construction + closes backlog #30), **capture/replay** (eval-runner fixtures via `RuntimeOptions` seam), **@file:path reference expansion** (pre-turn user-input rewriting in the turns route), **subdirectory hints** (CLAUDE.md/AGENTS.md ancestor walk threaded onto ToolContext), **skill-as-slash-command** (server-side skill loading + filtering + `GET /skills` discovery + Go TUI `/skillname` dispatch), **skill visibility filtering** (per-turn `filterSkillRegistry` narrowing), **goodbye summary** (extending M7's `session_summary` SSE event with rich `SessionMetrics`), **stall / no-op detection** (verify `detectStall` fires in server mode + emit `stall_detected` SSE event), and **tool-result expand registry** (Go TUI `/expand [N]` dispatch from local transcript model). Nine prereq boxes flip in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` (rows 14, 16, 17, 18, 19, 20, 21, 22, 24). One open backlog item (#30) closes. `--ui tui` reaches full parity with `terminalRepl.ts` on every surface flagged in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, clearing the way for M9 visual polish, M10 parity audit, and M11 default flip.

**Architecture:** M8 has TWO architectural threads. **Thread 1 — Server-side parity wiring:** five subsystems are tools the model uses (router, capture/replay, @file expansion, subdir hints, skill loading) — they wire into `buildRuntime` and the turns route via patterns the M5/M6/M7 work already established. **Thread 2 — Slash-command dispatch:** four subsystems involve user-facing TUI slash commands (`/skillname`, `/expand`, plus the existing `/compact` reference pattern). M8 ratifies the M6 `/compact` precedent: **TUI intercepts the slash, dispatches client-side for class (b) commands, or POSTs to a per-command route for class (a)/(c) commands.** No generic `POST /commands` dispatcher (rejected — see M8-01 below). Three new per-command routes: `GET /sessions/:id/skills` (skill discovery), and optionally a future `GET /sessions/:id/tool-results/:n` if the TUI ever evicts full tool-result content from memory (deferred — `/expand` v1 works from the TUI's local transcript model).

**Tech Stack:** TS / Bun (server), Hono routes, `bun:test` (TS); Go 1.24 / Bubble Tea (client TUI), `go test`. No new dependencies introduced. All nine subsystems are existing TS modules under `src/router/`, `src/eval/replay/`, `src/context/`, `src/skills/`, `src/review/`, `src/ui/`.

**Spec references:**
- `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §9 (M8 group row), §10 (M8 row in milestone sequence), §13 (open Qs deferred to plan)
- `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` rows 14 (Router), 16 (Capture/Replay), 17 (@file), 18 (Subdir hints), 19 (Skill-as-slash), 20 (Skill visibility), 21 (Goodbye), 22 (Stall), 24 (Expand)
- `docs/08-roadmap/backlog/post-phase-13-4.md` item #30 (server-mode `subagentDefaultProvider`/`subagentDefaultModel` not specialized for router mode — closes in T1)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4 (terminalRepl untouched; coexistence; audit before flip)
- `plans/2026-05-14-phase-16-1-m6-long-session.md` — M6 plan establishing the per-route slash-command pattern (M6 T5 `/compact` route + M6 T6 TUI intercept)
- `plans/2026-05-15-phase-16-1-m7-hermes-layer.md` — M7 plan establishing the SessionContext per-session pattern; M8 extends a couple of SessionContext fields (subdirectoryHintState in T3)
- `docs/07-history/state/2026-05-15.md` — M7 close-out + post-close hardening snapshot (where M8 boots from)
- `src/router/provider.ts:43-157` (RouterProvider), `src/router/auditLogger.ts:59-116` (RouterAuditLogger)
- `src/eval/replay/capture.ts:19-172`, `src/eval/replay/loader.ts:13-70`, `src/eval/replay/provider.ts:20-62`, `src/eval/replay/toolPool.ts:15-59`
- `src/context/references.ts:24-41` (`expandContextReferences`)
- `src/context/subdirectoryHints.ts:12-32` (`createSubdirectoryHintState`, `appendSubdirectoryHints`)
- `src/core/orchestrator.ts:640-653` — orchestrator's per-tool-result subdir-hint call site (already wired; M8 only needs to populate `ctx.subdirectoryHintState`)
- `src/skills/commands.ts:9-30` (`buildSkillCommands`), `src/skills/loader.ts:68-128` (`loadSkills`), `src/skills/visibility.ts:6-55` (`isSkillVisible`, `filterSkillRegistry`, `inferActiveToolsets`)
- `src/ui/sessionSummary.ts:8-62` (`renderSessionSummary`, `SessionMetrics`)
- `src/review/stall.ts:5-50` (`detectStall`, `TurnSummary`, `StallResult`)
- `src/core/query.ts:356-395` (existing per-turn stall detection call site)
- `src/ui/toolSlot.ts:81-186` (`CompactToolSlot` — REPL reference for `/expand`)
- `src/commands/info.ts:57-79` (`/expand` REPL handler — reference)
- `src/server/runtime.ts:98-231` (current `RuntimeOptions` / `Runtime` shape)
- `src/server/routes/turns.ts:128-144` (`buildSessionToolContext`), `:189-194` (user-message persist site for @file expansion)
- `src/server/routes/compact.ts` (M6 reference for per-command route pattern)
- `packages/tui/internal/app/app.go:199-206,526-538` (M6 reference for TUI slash interception + dispatch pattern)
- `packages/tui/internal/transport/api.go` (M6 reference for TUI-side HTTP client helpers)

**Scope guard — what M8 does NOT do:**
- **No generic `POST /sessions/:id/commands` dispatcher.** Per M8-01, M8 extends the M6 per-route precedent; each polish surface that needs server data gets its own dedicated endpoint. A future milestone may unify if more than ~6 routes exist by then.
- **No Go TUI goodbye card rendering.** M8 extends the `session_summary` SSE event payload (T7); M9 owns the styled card component in `packages/tui/internal/components/goodbye.go` (M9 polish — no stub exists yet per Cluster D agent intel).
- **No `stall_detected` TUI rendering.** T7 emits the SSE event; M9 owns the visual badge (e.g., a status-line indicator).
- **No real-Anthropic test additions.** M8 ships entirely against the mock provider for automated tests. Real-Anthropic autonomous smoke happens as a separate post-T9 hardening pass, mirroring M7's pattern.
- **No `/expand` server route.** Per M8-10, the Go TUI's transcript model retains full tool_result content client-side; `/expand` re-renders without truncation locally. A future tool-result-eviction policy may need `GET /sessions/:id/tool-results/:n`; deferred.
- **No `/review` slash command in the TUI.** Deferred from M7 (M7-07); M8 does not pick it up. The propose-then-promote pipeline (the model's `memory_propose` / `skill_propose` tool calls + the consolidation sub-agent) already works server-side; client-side `/review list/show/approve/reject/revoke/consolidate/activity` UX is a separate larger story. Backlog candidate for a focused mini-phase post-M11.
- **No skill auto-complete in the TUI.** T6 wires `/skillname` interception with exact match; fuzzy autocomplete (typing `/foo` and seeing suggestions) lands with M9's slash-autocomplete popup work per the spec.
- **No `/clear` or `/quit` slash commands in the TUI.** Class (b) commands per the agent classification — TUI-side only; not on the M8 critical path. May land opportunistically if a task touches the same Go file.
- **No router escalation UX.** RouterProvider supports interactive escalation (`escalationMode: 'ask'`) via an `escalationAsker` hook in terminalRepl. Server-mode router (T1) defaults to `escalationMode: 'never'` or `'auto'` — no SSE-driven escalation prompt in v1. Backlog candidate.
- **`--ui tui` stays opt-in through M11.** M8 does not flip the default.
- **terminalRepl untouched (Postmortem Rule 1).** Every wiring lives parallel-additive in the server side. M8 does not import, modify, or rename any helper module under `src/ui/`, `src/commands/`, or REPL-only files.

---

## Inline Decisions (resolutions of Spec §13 Open Qs for this milestone)

| Decision | Resolution | Rationale |
|---|---|---|
| **M8-01 — Slash-command architecture: hybrid TUI preprocessor + per-command routes** | TUI intercepts user input starting with `/`. Class (b) commands (purely TUI-state, e.g., `/quit`, `/clear`) dispatch client-side. Class (a)/(c) commands (server data OR hybrid) POST to a dedicated per-command route (M6 `/compact` precedent). No generic `POST /commands` dispatcher. | Closes the "Open question" about slash dispatch architecture per the M7 plan's M7-07 deferral. The CommandContext type has ~20 fields and ~half are REPL-internal closures (e.g., `setModel`, `clearHistory`, `requestExit`) that don't map cleanly to stateless HTTP. A generic dispatcher would either be brittle (fail on commands that need closure context) or expensive (populate full context per request). Per-route avoids both; each command's HTTP shape is explicit and minimal. M9 may unify if the route count grows past ~6. |
| **M8-02 — Router server-side construction closes backlog #30** | When `userSettings.defaultProvider === 'router'`, `buildRuntime` constructs a `RouterProvider` wrapping the configured `localProvider` + `frontierProvider` with the M5.1 `LaneSemaphores` caps + a new server-mode `RouterAuditLogger` (writes to `<harnessHome>/router/audit.jsonl`). The `subagentDefaultProvider` / `subagentDefaultModel` fall-through is specialized exactly like terminalRepl.ts:908-917 — closes backlog #30. | terminalRepl's router specialization (lines 238-292) is the reference. server-side mirroring requires three additions to `buildRuntime`: (a) detect `provider === 'router'` and build the RouterProvider; (b) populate `subagentDefault*` from the frontier lane (not the literal `'router'` string which doesn't resolve); (c) inject the audit logger. Server-mode router defaults `escalationMode: 'auto'` — no interactive ask path in v1. |
| **M8-03 — Capture/Replay path: RuntimeOptions seam + buildRuntime wrap + disposal-time finalize** | New `RuntimeOptions.captureFixturePath?: string` and `RuntimeOptions.replayFixturePath?: string`. Mutex check in `buildRuntime` (cannot pass both). When `replayFixturePath` set: load fixture via `loadReplayFixture(path)`, construct `ReplayProvider` instead of resolving a real one, wrap the tool pool via `wrapToolsForReplay(toolPool, fixture)`, skip preflight. When `captureFixturePath` set: construct `createCaptureSink()`, wrap provider via `new CapturingProvider(resolved.transport, sink)`, wrap tool pool via `wrapToolsForCapture(toolPool, sink)`. On `runtime.dispose()` (any path: explicit dispose or process exit), call `sink.finish()` and `writeReplayFixture(path, fixture)` if capture is active. | M6 / M7 established the `RuntimeOptions` injection-seam pattern (e.g., `microcompactConfig?`, `mcpClientPool?`, `daemonEventBus?`, `sessionContextFactory?`). Capture/Replay slots in as two more options. Mutex check matches terminalRepl.ts:414. Disposal-time finalize matches the trajectory-write timing from M7 T4; can land in `disposeSessionContext`'s tail OR directly in `runtime.dispose()` before MCP shutdown — choose `runtime.dispose()` because fixtures are runtime-scoped (one per process), not session-scoped. |
| **M8-04 — @file:path expansion: at turn submission, before saveMessage** | In `src/server/routes/turns.ts`, before the existing `runtime.sessionDb.saveMessage(sessionId, ...)` call (around line 189), call `expandContextReferences(text, { cwd: runtime.cwd })` and use the expanded result as the user message content. The expansion is async (`Promise<string>`); the turns route is already async so this lands cleanly. | Mirrors terminalRepl.ts:1288 timing — expand BEFORE persisting the message so the persisted history has the expanded content (no surprise re-expansion on resume). Async-safe because the surrounding code is already an async function. Failures inside `expandContextReferences` (e.g., file read errors, URL fetch failures) are inlined into the message text as `[ERROR: ...]` markers; no exception bubbles to the route. |
| **M8-05 — Subdirectory hints: thread `subdirectoryHintState` onto SessionContext + ToolContext** | M7 introduced per-session `SessionContext`. M8 extends it with a `subdirectoryHintState: SubdirectoryHintState` field constructed via `createSubdirectoryHintState()` in `buildSessionContext`. The `buildSessionToolContext` helper threads `sessionCtx.subdirectoryHintState` onto the returned `ToolContext.subdirectoryHintState`. The orchestrator's per-tool-result `appendSubdirectoryHints` call (`src/core/orchestrator.ts:640-653`) already reads from `ctx.subdirectoryHintState` — once populated, hints fire automatically for every tool that reads from a new directory. | Zero changes to `src/core/orchestrator.ts` — it already does the right thing when `ctx.subdirectoryHintState` is present. The gap is exclusively that server-mode SessionContext doesn't populate it. Per-session ownership matches the M7 pattern (one state per session id; the state's `touched: Set<string>` survives compaction pivots because SessionContext rebuilds on the new id — the touched-set lookup is per-directory, not per-session-id, so deduplication still works as the user expects). |
| **M8-06 — Skill registry: load once in `buildRuntime`, filter per-call in `buildSessionToolContext`** | `buildRuntime` calls `loadSkills({ cwd, harnessHome, bundleRoot })` once at boot and stores the result on `Runtime.skills: SkillRegistry`. `buildSessionToolContext` (called per turn) reads `runtime.skills` and applies `filterSkillRegistry(skills, inferActiveToolsets(activeToolNames), activeToolNames)` to produce the filtered registry. The filtered registry is threaded onto `ToolContext.skills` so the orchestrator's existing skill consumers see only the right set. A new `GET /sessions/:id/skills` route returns the filtered registry's `whenToUse` + `name` data so the Go TUI can intercept `/skillname` and dispatch (T6). | Mirrors terminalRepl.ts:476-478 (filter call site) and the M7 SessionContext pattern (load once, narrow per-call). Per-call filtering matches the REPL's per-turn cadence. The GET route is the minimum surface the TUI needs — it doesn't need the skill BODY for dispatch (the TUI doesn't render the skill; it forwards the slash to the server which expands the skill into a user-message turn). Actually — see M8-07 below for whether the TUI or the server expands. |
| **M8-07 — Skill-as-slash dispatch: TUI sends the slash verbatim; server-side turns route expands** | Go TUI intercepts user input starting with `/`. If the input matches a known skill name (from the cached `GET /sessions/:id/skills` response), the TUI POSTs to `/sessions/:id/turns` with body `{ text: '<the raw slash command>', kind: 'skill' }` (new optional `kind` field on the turn request body). The turns route detects `kind === 'skill'`, parses the slash, expands via `expandSkillPrompt(...)`, and treats the expanded body as a normal user message (proceeds through @file expansion + saveMessage + query). | Keeps the TUI thin (no skill expansion logic client-side; no Go duplication of `expandSkillPrompt`). Keeps the server route the single expansion authority. The `kind` field is the minimum protocol extension. Alternative considered: TUI computes the expansion via a `POST /sessions/:id/skills/:name/expand` round-trip, then submits the expanded text as a normal turn. Rejected because (a) extra round-trip latency, (b) the TUI doesn't need to SEE the expanded text. M9 may add a UX where the user sees `→ expanding skill foo…` as a transcript marker; that's renderer-side and doesn't change M8's contract. |
| **M8-08 — Goodbye summary: extend `session_summary` SSE event payload with rich `SessionMetrics`** | M7's `SessionSummaryEvent` payload is `{ totalDispatched, byAgent }`. M8 extends to the full `SessionMetrics` shape from `src/ui/sessionSummary.ts:8-34`: adds `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`, `estimatedCostUsd`), `agentActiveMs`, `apiTimeMs`, `toolTimeMs`, `toolCalls`, `toolOk`, `toolErr`, `startedAtMs`, `endedAtMs`. `disposeSessionContext` reads from `runtime.sessionDb.getSessionCost(sessionId)` (already wired in M7's I1 fix) plus a new `runtime.sessionDb.getSessionMetrics(sessionId)` accessor (sessionDb stores turn/tool counts via existing recordTurnCount/recordToolEvent calls). | M7 left the event payload minimal (reviews only) because the renderer was deferred to M9 and there was no value in shipping more. M8 ships the full payload because (a) the data is cheap to gather at disposal, (b) M9's renderer is closer and benefits from having the data flow ready, (c) the Sovereign moat consumers (trajectory + corpus) can subscribe to the bus and harvest rich session metrics without parsing the SessionDb. The Go TUI's M9 goodbye-card renderer becomes a pure formatter on this payload. |
| **M8-09 — Stall detection: verify server-side firing + emit `stall_detected` SSE event** | `detectStall` already fires per-turn in `src/core/query.ts:391` — verify with a server-mode integration test that the `stall_detected` trace event lands in the per-session trace file when three empty/error-only turns run sequentially. M8 adds a new `stall_detected` SSE event type in `src/server/schema.ts` (parallel to `compaction_complete`, `session_summary`); the turns route maps the `stall_detected` stream event from `query()` into the wire event (similar to `mapStreamEventToServerEvent` for other types). | The detection IS already firing server-side (the call site is in `src/core/query.ts`, shared with terminalRepl). The gap is exclusively that the server doesn't surface the signal on the wire — the Go TUI can't render a stall badge without it. T7 adds the SSE event type. The Go TUI badge renderer is M9 polish; M8 just emits and verifies. |
| **M8-10 — `/expand [N]`: TUI-side from local transcript model** | The Go TUI's transcript model retains FULL `tool_result.Output` content (the server already sends full payloads per the Cluster D agent intel — no truncation server-side). TUI maintains a ring buffer of completed tool blocks (size capped at 50 to match REPL's `CompactToolSlot.retain` default). The TUI's input handler intercepts `/expand [N]` (matching the M6 `/compact` interception pattern), reads the Nth block from the local ring buffer, and re-renders WITHOUT the inline-line truncation. No server route. | Saves a round-trip; saves a server route; matches `/expand`'s semantic (transcript-side re-rendering, not server data fetching). The 50-block buffer cap mirrors the REPL's default. Edge case: if the TUI is launched with `--resume <id>`, the buffer starts empty (the server's resume hydration sends the message history but doesn't replay tool blocks one-by-one through the TUI's `tool_result` SSE handler). M8 ships v1 with the resume-empty-buffer caveat documented; M9 polish may add a backfill from `runtime.sessionDb.getCompletedToolBlocks(sessionId)`. |

---

## File Structure

### New files

| Path | Responsibility | Approx. LoC |
|---|---|---|
| `src/server/routes/skills.ts` | `GET /sessions/:id/skills` route returning `{ skills: Array<{ name, whenToUse, description? }> }` from the filtered per-session skill registry. Reads from `runtime.skills` + filters via the same `inferActiveToolsets`/`filterSkillRegistry` pipeline `buildSessionToolContext` uses. | ~80 |
| `tests/server/runtime.router.test.ts` | `buildRuntime` with `provider: 'router'` + router settings constructs a RouterProvider; `runtime.resolvedProvider.transport.name === 'router'`; `subagentDefaultProvider` matches the frontier lane (closes #30). | ~140 |
| `tests/server/runtime.capture.test.ts` | `buildRuntime({ captureFixturePath })` wraps provider + tools; fires one mock-provider turn; `runtime.dispose()` writes the fixture; fixture round-trips through `loadReplayFixture` cleanly. | ~150 |
| `tests/server/runtime.replay.test.ts` | `buildRuntime({ replayFixturePath })` loads fixture, constructs ReplayProvider, preflight skipped; one turn drives through fixture without hitting the network; `replayProvider.isExhausted` true after the full turn count. | ~140 |
| `tests/server/turns.references.test.ts` | POST `/sessions/:id/turns` with `text: 'check @file:src/foo.ts'` → user message persisted with the file contents inlined; missing-file path lands as `[ERROR: file not found ...]` marker. | ~130 |
| `tests/server/sessionContext.subdirHints.test.ts` | `SessionContext` includes `subdirectoryHintState`; turn fires; tool reads from a directory containing `AGENTS.md`; tool result includes the appended hint block. | ~140 |
| `tests/server/runtime.skills.test.ts` | `buildRuntime` loads skills via `loadSkills`; `runtime.skills` populated; `buildSessionToolContext` filters via `filterSkillRegistry`; filtered registry on ToolContext matches the active toolset. | ~140 |
| `tests/server/routes/skills.test.ts` | GET `/sessions/:id/skills` returns 200 with JSON body matching the filtered registry; 404 on unknown session id; 400 on malformed id. | ~120 |
| `tests/server/turns.skillSlash.test.ts` | POST `/sessions/:id/turns` with `{ text: '/foo arg', kind: 'skill' }` → server expands `foo` via `expandSkillPrompt`; expanded body persisted as user message; downstream query() sees the expanded text. | ~150 |
| `tests/server/turns.stallDetected.test.ts` | Three consecutive empty-mock-provider turns fire `stall_detected` SSE event with `reason` carrying the StallResult string. | ~160 |
| `tests/server/sessionContext.sessionSummary.test.ts` | `disposeSession({ bus })` emits `session_summary` event with the rich `SessionMetrics` payload (tokens, durations, tool counts); `byAgent` map preserved from M7 contract. | ~180 |
| `packages/tui/internal/transport/skills.go` | Go-side `GetSkills(baseURL, sessionID)` helper + `Skill` struct (mirrors the SSE schema's `skill_summary`-shaped response). Used by T6 for `/skillname` detection. | ~80 |
| `packages/tui/internal/app/expand.go` | Go-side `/expand [N]` interception + local-ring-buffer reads + re-render call. Keeps the input-handler diff in `app.go` minimal — most logic lives here. | ~120 |
| `packages/tui/internal/transport/skills_test.go` | Unit tests for `GetSkills` and the skill JSON decode contract. | ~70 |
| `packages/tui/internal/app/expand_test.go` | Unit tests for the ring-buffer reads + `/expand [N]` argument parsing. | ~100 |

### Modified files

| Path | Modification |
|---|---|
| `src/server/runtime.ts` | (a) Import `RouterProvider`, `RouterAuditLogger`, `loadSkills`, `SkillRegistry`, `createCaptureSink`, `CapturingProvider`, `wrapToolsForCapture`, `ReplayProvider`, `loadReplayFixture`, `wrapToolsForReplay`, `writeReplayFixture`. (b) Extend `RuntimeOptions` with `captureFixturePath?`, `replayFixturePath?`. (c) Extend `Runtime` with `skills: SkillRegistry`. (d) Router specialization branch in `buildRuntime` when `provider === 'router'`. (e) Capture/Replay wrap before tool pool assembly. (f) Skill load. (g) Capture finalize in `runtime.dispose()` before MCP shutdown. (h) Specialize `subagentDefaultProvider`/`subagentDefaultModel` for router mode (closes #30). |
| `src/server/sessionContext.ts` | Extend `SessionContext` type with `subdirectoryHintState: SubdirectoryHintState` (M8-05). `buildSessionContext` constructs via `createSubdirectoryHintState()`. No disposal action needed (the state is plain data; no resources to release). |
| `src/server/routes/turns.ts` | (a) Import `expandContextReferences` from `'../../context/references.js'`. (b) Before user-message saveMessage (around line 189), call `expandContextReferences(text, { cwd: runtime.cwd })` and use the result. (c) Parse `kind: 'skill'` from request body and dispatch to skill-expansion path (M8-07). (d) `buildSessionToolContext` extends with `subdirectoryHintState` from sessionCtx (M8-05) + filtered `skills` from `inferActiveToolsets(activeToolNames)` + `filterSkillRegistry(runtime.skills, ...)` (M8-06). (e) `mapStreamEventToServerEvent` adds case for `stall_detected` stream event → `stall_detected` wire event (M8-09). |
| `src/server/app.ts` | Mount the new `skills` route via `app.route('/sessions/:id/skills', skillsRoute(runtime))`. |
| `src/server/schema.ts` | Add `StallDetectedEvent` Zod schema: `{ type: 'stall_detected', seq, sessionId, reason: string, turn: number }`. Add to the `WireEvent` discriminated union. Extend `SessionSummaryEvent` payload with `tokens?`, `agentActiveMs?`, `apiTimeMs?`, `toolTimeMs?`, `toolCalls?`, `toolOk?`, `toolErr?`, `startedAtMs`, `endedAtMs` (all optional except where the M7 payload required them; M9 renderer reads what's present). |
| `src/agent/sessionDb.ts` | Add `getSessionMetrics(sessionId): SessionMetricsRow` accessor that joins the existing token-usage + tool-event tables into the M8 SessionMetrics shape. (Token-usage table already exists from M7's cost-fix; tool-event aggregation may need a new SQL view or two new SUM queries — implementer reads the existing recordToolEvent shape to decide.) |
| `packages/tui/internal/app/app.go` | (a) Intercept `/skillname` in the input handler before passing to POST /turns. (b) On boot, fetch `/sessions/:id/skills` and cache locally for the slash interception. (c) Intercept `/expand [N]` and dispatch to `expand.go`. (d) Maintain local ring buffer of completed tool blocks (max 50) updated on each `tool_result` SSE event. |
| `packages/tui/internal/transport/api.go` | Add `Skill` struct + JSON tags matching the GET /skills response. |
| `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` | Flip checkboxes for rows 14 (Router), 16 (Capture/Replay), 17 (@file), 18 (Subdir hints), 19 (Skill-as-slash), 20 (Skill visibility), 21 (Goodbye), 22 (Stall), 24 (Expand) with `(M8 — 2026-05-XX)` annotation. |
| `docs/08-roadmap/backlog/post-phase-13-4.md` | Close item #30 (router-mode default subagent provider/model in server build). |
| `DECISIONS.md` | Add ADR stubs: M8-01 (slash-command architecture), M8-02 (router server-side), M8-03 (capture/replay seam + finalize), M8-06 (skill registry placement), M8-07 (skill dispatch via turn `kind`), M8-08 (extended session_summary payload), M8-10 (TUI-side `/expand`). M8-04 / M8-05 / M8-09 are scope decisions (no architectural lock-in), noted in snapshot. |
| `docs/07-history/state/2026-05-XX.md` (close-out date) | New close-out snapshot — supersedes `docs/07-history/state/2026-05-15.md`. |
| `CLAUDE.md` / `AGENTS.md` | Update the state-snapshot pointer to the new dated file. Byte-identical mirror invariant preserved. |

---

## Files Touched (by task)

| Task | Modifies | Creates | Tests |
|---|---|---|---|
| T1 | `src/server/runtime.ts` | — | `tests/server/runtime.router.test.ts` |
| T2 | `src/server/runtime.ts` | — | `tests/server/runtime.capture.test.ts`, `tests/server/runtime.replay.test.ts` |
| T3 | `src/server/routes/turns.ts`, `src/server/sessionContext.ts` | — | `tests/server/turns.references.test.ts`, `tests/server/sessionContext.subdirHints.test.ts` |
| T4 | `src/server/runtime.ts`, `src/server/routes/turns.ts`, `src/server/app.ts` | `src/server/routes/skills.ts` | `tests/server/runtime.skills.test.ts`, `tests/server/routes/skills.test.ts` |
| T5 | `src/server/routes/turns.ts` | — | `tests/server/turns.skillSlash.test.ts` |
| T6 | `packages/tui/internal/app/app.go`, `packages/tui/internal/transport/api.go` | `packages/tui/internal/transport/skills.go`, `packages/tui/internal/transport/skills_test.go`, `packages/tui/internal/app/expand.go`, `packages/tui/internal/app/expand_test.go` | (Go-side unit tests) |
| T7 | `src/server/sessionContext.ts`, `src/server/routes/turns.ts`, `src/server/schema.ts`, `src/agent/sessionDb.ts` | — | `tests/server/turns.stallDetected.test.ts`, `tests/server/sessionContext.sessionSummary.test.ts` |
| T8 | `tests/server/integration/m8Full.test.ts`, `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, `docs/08-roadmap/backlog/post-phase-13-4.md`, `DECISIONS.md`, `docs/07-history/state/<date>.md`, `CLAUDE.md`, `AGENTS.md` | `tests/server/m8Full.test.ts` | (extends integration test with full M8 sweep) |

---

## Task 1: Router server-side wiring (closes backlog #30)

**Goal:** When `userSettings.defaultProvider === 'router'`, `buildRuntime` constructs a `RouterProvider` wrapping the configured `localProvider`/`frontierProvider`, threads in the existing `LaneSemaphores` (already on `Runtime` from M5.1 #27), and constructs a server-mode `RouterAuditLogger` writing to `<harnessHome>/router/audit.jsonl`. The `subagentDefaultProvider`/`subagentDefaultModel` fall-through specializes to the frontier lane instead of the literal `'router'` string (closes backlog #30). Closes prereq row 14.

**Files:**
- Modify: `src/server/runtime.ts`
- Create: `tests/server/runtime.router.test.ts`

**Spec / inventory pointers:**
- `src/router/provider.ts:43-157` — `RouterProvider` class. Constructor opts: `{ config, localProvider, frontierProvider, auditLogger?, sessionId?, localContextLength?, getNextOverride?, escalationAsker? }`.
- `src/router/auditLogger.ts:59-116` — `RouterAuditLogger` class. Constructor opts: `{ path?, harnessHome?, log? }`.
- `src/config/schema.ts:180-197` — router settings: `localProvider`, `localModel?`, `frontierProvider`, `frontierModel?`, `defaultLane?`, `escalationMode?`, `maxConcurrentLocal?`, `maxConcurrentFrontier?`.
- `src/ui/terminalRepl.ts:238-292` — reference RouterProvider construction.
- `src/ui/terminalRepl.ts:908-917` — reference subagent-default specialization for router mode.
- `src/providers/resolver.ts` — `resolveProvider()` does NOT handle `'router'`. The router wraps two providers; M8 constructs it AFTER resolveProvider returns the underlying providers.

- [ ] **Step 1: Verify RouterProvider + RouterAuditLogger surface**

Run:

```bash
grep -n 'export class\|export type\|export function' src/router/provider.ts src/router/auditLogger.ts
```

Expected: `export class RouterProvider`, `export class RouterAuditLogger`, plus their option types. Confirm with the source.

- [ ] **Step 2: Write the failing test**

Create `tests/server/runtime.router.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — router server-side construction (M8 T1)', () => {
  let tmpHome: string;
  const prevHarnessConfig = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t1-'));
    process.env.HARNESS_CONFIG = join(tmpHome, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (prevHarnessConfig === undefined) {
      delete process.env.HARNESS_CONFIG;
    } else {
      process.env.HARNESS_CONFIG = prevHarnessConfig;
    }
  });

  test('provider:router with valid router settings constructs RouterProvider', async () => {
    writeFileSync(
      process.env.HARNESS_CONFIG!,
      JSON.stringify({
        providers: {
          anthropic: { apiKey: 'test-key' },
        },
        router: {
          localProvider: 'mock',
          frontierProvider: 'mock',
          defaultLane: 'local',
        },
      }),
    );

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'router',
      preflight: false,
    });

    expect(runtime.resolvedProvider.transport.name).toBe('router');

    await runtime.dispose();
  });

  test('subagentDefaultProvider specializes to frontier lane (closes backlog #30)', async () => {
    writeFileSync(
      process.env.HARNESS_CONFIG!,
      JSON.stringify({
        providers: { anthropic: { apiKey: 'test-key' } },
        router: {
          localProvider: 'mock',
          localModel: 'mock-local',
          frontierProvider: 'mock',
          frontierModel: 'mock-frontier',
          defaultLane: 'local',
        },
      }),
    );

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'router',
      preflight: false,
    });

    // The subagent scheduler should have been constructed with frontier-lane defaults.
    // Read the scheduler's defaultProvider/defaultModel via its public API or
    // inspect via the scheduler's introspection. Verify with grep first:
    // grep -n 'defaultProvider\|defaultModel' src/runtime/scheduler.ts
    // — if the scheduler exposes them, assert; otherwise reach into a known
    // property (the test is fixture for the M8 T1 invariant).
    const scheduler = runtime.subagentScheduler as unknown as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    expect(scheduler.defaultProvider).toBe('mock');
    expect(scheduler.defaultModel).toBe('mock-frontier');

    await runtime.dispose();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/server/runtime.router.test.ts`

Expected: FAIL — `resolveProvider` likely throws or returns unexpected shape for `provider: 'router'`; the subagent specialization isn't in `buildRuntime` yet.

- [ ] **Step 4: Add imports to `src/server/runtime.ts`**

After the existing imports (verify order; the file has a Biome-enforced sort):

```typescript
import { RouterProvider } from '../router/provider.js';
import { RouterAuditLogger } from '../router/auditLogger.js';
```

- [ ] **Step 5: Add router branch in `buildRuntime` after `resolveProvider`**

Locate the existing `const resolved = resolveProvider(opts.provider, opts.model, { harnessHome });` call (around line 329 per the M7 state). When `opts.provider === 'router'`, the resolver currently doesn't handle this — `resolveProvider` is for single-provider resolution. The router needs explicit construction. Add a branch:

```typescript
// M8 T1 — router server-side specialization. When the user configures
// provider: 'router', resolveProvider can't be the single source of truth
// because the router wraps TWO providers. Construct it explicitly here.
// Mirrors terminalRepl.ts:238-292.
let resolved: ResolvedProvider;
let routerAuditLogger: RouterAuditLogger | undefined;
if (opts.provider === 'router' || userSettings.defaultProvider === 'router') {
  const routerCfg = userSettings.router;
  if (!routerCfg) {
    throw new Error('provider: router requires settings.router to be configured');
  }
  const localResolved = resolveProvider(routerCfg.localProvider, routerCfg.localModel, { harnessHome });
  const frontierResolved = resolveProvider(routerCfg.frontierProvider, routerCfg.frontierModel, { harnessHome });
  routerAuditLogger = new RouterAuditLogger({ harnessHome });
  const router = new RouterProvider({
    config: {
      localProvider: localResolved.transport,
      frontierProvider: frontierResolved.transport,
      localModel: localResolved.model,
      frontierModel: frontierResolved.model,
      defaultLane: routerCfg.defaultLane ?? 'frontier',
      escalationMode: routerCfg.escalationMode ?? 'auto',
    },
    localProvider: localResolved.transport,
    frontierProvider: frontierResolved.transport,
    auditLogger: routerAuditLogger,
    localContextLength: localResolved.contextLength,
  });
  resolved = {
    transport: router,
    model: opts.model ?? frontierResolved.model,
    contextLength: frontierResolved.contextLength,
    metadata: {
      provider: 'router',
      localProvider: routerCfg.localProvider,
      frontierProvider: routerCfg.frontierProvider,
    },
  };
} else {
  resolved = resolveProvider(opts.provider, opts.model, { harnessHome });
}
```

(Exact shape of `ResolvedProvider` should be verified against `src/providers/resolver.ts` — the test will fail loud if the shape diverges.)

- [ ] **Step 6: Specialize `subagentDefaultProvider`/`subagentDefaultModel` for router mode (closes #30)**

Locate the existing `SubagentScheduler` construction (around line 468–491 per M5/M5.1 state). Currently passes `defaultProvider: resolved.transport.name` and `defaultModel: resolved.model`. When the resolved provider is router, the literal string `'router'` doesn't itself resolve — children would fail to dispatch. Mirror terminalRepl.ts:908-917:

```typescript
// M8 T1 / backlog #30 — when the runtime is router-mode, sub-agent defaults
// must specialize to the frontier lane (not the literal 'router' string,
// which would fail to resolve in the child).
const isRouterMode = resolved.transport.name === 'router';
const subagentDefaultProvider = isRouterMode
  ? (resolved.metadata as { frontierProvider?: string }).frontierProvider ?? resolved.transport.name
  : resolved.transport.name;
const subagentDefaultModel = isRouterMode
  ? userSettings.router?.frontierModel ?? resolved.model
  : resolved.model;
```

Pass `subagentDefaultProvider` and `subagentDefaultModel` into the `new SubagentScheduler({...})` constructor — replace the previous `defaultProvider: resolved.transport.name` with the specialized values.

- [ ] **Step 7: Dispose the audit logger in `runtime.dispose()`**

In the `dispose: async () => { ... }` body, before MCP shutdown:

```typescript
if (routerAuditLogger) await routerAuditLogger.close();
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test tests/server/runtime.router.test.ts`

Expected: PASS — both tests pass.

- [ ] **Step 9: Run the full server suite + lint + typecheck**

Run: `bun test tests/server/ && bun run lint && bun run typecheck`

Expected: PASS. No regressions.

- [ ] **Step 10: Testing-log entry and commit**

Append `## 2026-05-XX — Phase 16.1 M8 T1 — router server-side construction + backlog #30 closed` entry.

```bash
git add src/server/runtime.ts tests/server/runtime.router.test.ts docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
feat(server): M8 T1 — router server-side construction (closes backlog #30)

buildRuntime now constructs RouterProvider when provider === 'router'
or userSettings.defaultProvider === 'router'. Wraps configured
localProvider + frontierProvider; ties into the existing M5.1
LaneSemaphores caps; writes audit log to <harnessHome>/router/audit.jsonl.

subagentDefaultProvider/Model specializes to the frontier lane (not the
literal 'router' string which doesn't resolve), mirroring
terminalRepl.ts:908-917. Closes backlog #30.
EOF
)"
git push origin master
```

- [ ] **Step 11: `sov upgrade`**

Run: `sov upgrade`

---

## Task 2: Capture/Replay server-side wiring

**Goal:** `buildRuntime` accepts `captureFixturePath?` and `replayFixturePath?` options. When replay path is set, constructs `ReplayProvider` + wraps tool pool. When capture path is set, wraps the real provider in `CapturingProvider` + wraps tool pool. On `runtime.dispose()`, capture finalizes and writes the fixture. Closes prereq row 16.

**Files:**
- Modify: `src/server/runtime.ts`
- Create: `tests/server/runtime.capture.test.ts`, `tests/server/runtime.replay.test.ts`

**Spec / inventory pointers:**
- `src/eval/replay/capture.ts:19-172` — `createCaptureSink()`, `CapturingProvider`, `wrapToolsForCapture`.
- `src/eval/replay/loader.ts:13-70` — `loadReplayFixture(path)`, `writeReplayFixture(path, fixture)`.
- `src/eval/replay/provider.ts:20-62` — `ReplayProvider`.
- `src/eval/replay/toolPool.ts:15-59` — `wrapToolsForReplay(tools, fixture)`.
- `src/ui/terminalRepl.ts:312-329` — reference for replay wiring.

- [ ] **Step 1: Write failing tests**

Create `tests/server/runtime.capture.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { buildAppWithRuntime } from '../../src/server/app.js';

describe('buildRuntime — capture fixture write on dispose (M8 T2)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t2-capture-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('captureFixturePath wraps provider; runtime.dispose() writes valid fixture', async () => {
    const fixturePath = join(tmpHome, 'fixture.json');
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      captureFixturePath: fixturePath,
    });

    const app = buildAppWithRuntime(runtime);
    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(turnRes.status).toBe(202);

    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    await eventsRes.text();

    await runtime.dispose();

    expect(existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(fixture.meta.provider).toBe('mock');
    expect(fixture.meta.model).toBe('mock-haiku');
    expect(Array.isArray(fixture.turns)).toBe(true);
    expect(fixture.turns.length).toBeGreaterThan(0);
  });

  test('captureFixturePath + replayFixturePath mutex throws', async () => {
    expect(
      buildRuntime({
        cwd: tmpHome,
        harnessHome: tmpHome,
        provider: 'mock',
        preflight: false,
        captureFixturePath: join(tmpHome, 'a.json'),
        replayFixturePath: join(tmpHome, 'b.json'),
      }),
    ).rejects.toThrow(/capture.*replay.*mutually exclusive|cannot.*both/i);
  });
});
```

Create `tests/server/runtime.replay.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { buildAppWithRuntime } from '../../src/server/app.js';

describe('buildRuntime — replay fixture loads ReplayProvider (M8 T2)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t2-replay-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('replayFixturePath constructs ReplayProvider and skips preflight', async () => {
    const fixturePath = join(tmpHome, 'fixture.json');
    // Minimal valid fixture: one turn emitting a single text_delta + assistant message.
    writeFileSync(
      fixturePath,
      JSON.stringify({
        meta: {
          sessionId: 'fixture-session',
          provider: 'mock',
          model: 'mock-haiku',
          capturedAt: '2026-05-16T00:00:00Z',
        },
        turns: [
          {
            turn: 0,
            providerEvents: [
              { type: 'text_delta', text: 'hello from replay' },
              { type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: 'hello from replay' }] } },
            ],
            toolResults: [],
          },
        ],
      }),
    );

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      // provider intentionally omitted — replay path drives provider selection
      replayFixturePath: fixturePath,
    });

    expect(runtime.resolvedProvider.transport.name).toBe('mock');
    expect(runtime.model).toBe('mock-haiku');

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun test tests/server/runtime.capture.test.ts tests/server/runtime.replay.test.ts`

Expected: FAIL — `RuntimeOptions` doesn't have `captureFixturePath` / `replayFixturePath` yet.

- [ ] **Step 3: Add imports + types to `src/server/runtime.ts`**

```typescript
import { type ReplayFixture, type CaptureSink, createCaptureSink, CapturingProvider, wrapToolsForCapture } from '../eval/replay/capture.js';
import { loadReplayFixture, writeReplayFixture } from '../eval/replay/loader.js';
import { ReplayProvider } from '../eval/replay/provider.js';
import { wrapToolsForReplay } from '../eval/replay/toolPool.js';
```

Extend `RuntimeOptions`:

```typescript
  /** Capture every provider call + tool call to a fixture file. On
   *  runtime.dispose() the fixture is finalized and written. Mutually
   *  exclusive with replayFixturePath. */
  captureFixturePath?: string;
  /** Drive the runtime from a recorded fixture file. Skips preflight
   *  and live provider calls. Mutually exclusive with captureFixturePath. */
  replayFixturePath?: string;
```

- [ ] **Step 4: Wire mutex check + replay branch + capture wrap in `buildRuntime`**

Near the top of `buildRuntime`, after option destructuring:

```typescript
if (opts.captureFixturePath && opts.replayFixturePath) {
  throw new Error('captureFixturePath and replayFixturePath are mutually exclusive');
}
```

Replace the existing `resolved = resolveProvider(...)` (or the router branch from T1) with a three-way switch:

```typescript
let resolved: ResolvedProvider;
let routerAuditLogger: RouterAuditLogger | undefined;
let captureSink: CaptureSink | undefined;

if (opts.replayFixturePath) {
  const fixture = await loadReplayFixture(opts.replayFixturePath);
  const replayProvider = new ReplayProvider({ fixture, providerName: fixture.meta.provider });
  resolved = {
    transport: replayProvider,
    model: fixture.meta.model,
    contextLength: 200_000, // Replay doesn't actually call the model; cap matches Anthropic for shape consistency
    metadata: { provider: fixture.meta.provider, replay: true },
  };
} else if (opts.provider === 'router' || userSettings.defaultProvider === 'router') {
  // ... T1 router branch ...
} else {
  resolved = resolveProvider(opts.provider, opts.model, { harnessHome });
  if (opts.captureFixturePath) {
    captureSink = createCaptureSink({
      sessionId: 'pending', // overwritten by first turn
      provider: resolved.transport.name,
      model: resolved.model,
    });
    resolved = { ...resolved, transport: new CapturingProvider(resolved.transport, captureSink) };
  }
}
```

After tool pool assembly, wrap for capture / replay:

```typescript
let toolPool = assembleToolPool(toolCtx, { mcpTools });
if (opts.replayFixturePath) {
  // Replay wraps each tool's call() to return the next captured result.
  const fixture = await loadReplayFixture(opts.replayFixturePath); // (cache earlier if expensive)
  toolPool = wrapToolsForReplay(toolPool, fixture);
} else if (captureSink) {
  toolPool = wrapToolsForCapture(toolPool, captureSink);
}
```

- [ ] **Step 5: Finalize capture in `runtime.dispose()`**

In the `dispose` body, before MCP shutdown:

```typescript
if (captureSink && opts.captureFixturePath) {
  const fixture = captureSink.finish();
  await writeReplayFixture(opts.captureFixturePath, fixture);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/server/runtime.capture.test.ts tests/server/runtime.replay.test.ts`

Expected: PASS.

- [ ] **Step 7: Full server suite + lint + typecheck**

Run: `bun test tests/server/ && bun run lint && bun run typecheck`

- [ ] **Step 8: Testing-log entry + commit**

```bash
git add src/server/runtime.ts tests/server/runtime.capture.test.ts tests/server/runtime.replay.test.ts docs/06-testing/testing-log.md
git commit -m "feat(server): M8 T2 — capture/replay fixture support in buildRuntime"
git push origin master
```

- [ ] **Step 9: `sov upgrade`**

---

## Task 3: Pre-turn context — @file expansion + subdirectory hints

**Goal:** Server turns route calls `expandContextReferences` on user-message text BEFORE persisting. `SessionContext` carries a `subdirectoryHintState` that `buildSessionToolContext` threads onto `ToolContext.subdirectoryHintState` — the orchestrator's existing `appendSubdirectoryHints` call (`src/core/orchestrator.ts:640-653`) then fires automatically. Closes prereq rows 17 and 18.

**Files:**
- Modify: `src/server/routes/turns.ts`, `src/server/sessionContext.ts`
- Create: `tests/server/turns.references.test.ts`, `tests/server/sessionContext.subdirHints.test.ts`

**Spec / inventory pointers:**
- `src/context/references.ts:24-41` — `expandContextReferences(input, opts?)`.
- `src/context/subdirectoryHints.ts:12-32` — `createSubdirectoryHintState()`, `appendSubdirectoryHints(opts)`.
- `src/ui/terminalRepl.ts:1288` — reference for @file expansion at input.
- `src/core/orchestrator.ts:640-653` — already calls `appendSubdirectoryHints` when `ctx.subdirectoryHintState` is present.
- `src/server/routes/turns.ts:189-194` — current saveMessage site.

- [ ] **Step 1: Write failing test for @file expansion**

Create `tests/server/turns.references.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { buildAppWithRuntime } from '../../src/server/app.js';

describe('turns route — @file:path reference expansion (M8 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t3-ref-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('@file:path in user text expands to file contents before saveMessage', async () => {
    writeFileSync(join(tmpHome, 'hello.txt'), 'hello from file');
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'read @file:hello.txt please' }),
    });
    await app.request(`/sessions/${sessionId}/events`).then((r) => r.text());

    const messages = runtime.sessionDb.loadMessages(sessionId);
    const userMsg = messages[0];
    const userText = JSON.stringify(userMsg.content);
    expect(userText).toContain('hello from file');
    expect(userText).not.toContain('@file:hello.txt'); // raw reference replaced

    await runtime.dispose();
  });

  test('@file:nonexistent.txt expands to error marker', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);
    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'check @file:nonexistent.txt' }),
    });
    await app.request(`/sessions/${sessionId}/events`).then((r) => r.text());

    const messages = runtime.sessionDb.loadMessages(sessionId);
    const userText = JSON.stringify(messages[0].content);
    expect(userText).toContain('[ERROR: file not found');

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Write failing test for subdirectory hints**

Create `tests/server/sessionContext.subdirHints.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('SessionContext.subdirectoryHintState (M8 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t3-hint-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('SessionContext exposes subdirectoryHintState with empty touched set', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: 'mock',
      platform: 'test',
    });
    const ctx = runtime.getSessionContext(sessionId);
    expect(ctx.subdirectoryHintState).toBeDefined();
    expect(ctx.subdirectoryHintState.touched.size).toBe(0);
    await runtime.dispose();
  });

  test('ToolContext receives the SessionContext subdirectoryHintState reference', async () => {
    // Verify buildSessionToolContext threads the field through; orchestrator
    // already consumes it (src/core/orchestrator.ts:640-653) so populating the
    // ToolContext field is the load-bearing assertion.
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: 'mock',
      platform: 'test',
    });
    const ctx = runtime.getSessionContext(sessionId);
    // buildSessionToolContext is exported from turns.ts; reach in via grep.
    const { buildSessionToolContext } = await import('../../src/server/routes/turns.js');
    const toolCtx = buildSessionToolContext(runtime, sessionId, runtime.canUseTool);
    expect(toolCtx.subdirectoryHintState).toBe(ctx.subdirectoryHintState);
    await runtime.dispose();
  });
});
```

- [ ] **Step 3: Run failing tests**

Run: `bun test tests/server/turns.references.test.ts tests/server/sessionContext.subdirHints.test.ts`

Expected: FAIL.

- [ ] **Step 4: Extend SessionContext with subdirectoryHintState**

In `src/server/sessionContext.ts`:

```typescript
import { type SubdirectoryHintState, createSubdirectoryHintState } from '../context/subdirectoryHints.js';

export type SessionContext = {
  sessionId: string;
  traceWriter: TraceWriter;
  trajectoryMetadata: TrajectoryMetadata;
  learningObserver?: LearningObserver;
  reviewManager?: ReviewManager;
  reviewAbortController: AbortController;
  /** M8 T3 — per-session ancestor-walk dedup state. Populated by
   *  createSubdirectoryHintState() at SessionContext build time;
   *  consumed by src/core/orchestrator.ts's appendSubdirectoryHints
   *  call after every tool result. */
  subdirectoryHintState: SubdirectoryHintState;
};
```

In `buildSessionContext`:

```typescript
return {
  sessionId,
  traceWriter,
  trajectoryMetadata: { toolCallCount: 0, iterationsUsed: 0, estimatedCostUsd: 0 },
  ...(learningObserver ? { learningObserver } : {}),
  ...(reviewManager ? { reviewManager } : {}),
  reviewAbortController,
  subdirectoryHintState: createSubdirectoryHintState(),
};
```

- [ ] **Step 5: Thread subdirectoryHintState onto ToolContext in turns route**

In `src/server/routes/turns.ts`, in `buildSessionToolContext`:

```typescript
return {
  cwd: runtime.cwd,
  sessionId,
  harnessHome: runtime.harnessHome,
  agents: runtime.agents,
  ...(runtime.bundle ? { bundleRoot: runtime.bundle.root } : {}),
  subagentScheduler: runtime.subagentScheduler,
  taskManager: runtime.taskManager,
  parentToolPool: runtime.toolPool,
  canUseTool: sessionCanUseTool,
  ...(sessionCtx.learningObserver ? { learningObserver: sessionCtx.learningObserver } : {}),
  ...(sessionCtx.reviewManager ? { reviewManager: sessionCtx.reviewManager } : {}),
  // M8 T3 — per-session subdirectory hint state. orchestrator reads
  // ctx.subdirectoryHintState after every tool result and appends
  // ancestor CLAUDE.md / AGENTS.md / CONTEXT.md files to the result.
  subdirectoryHintState: sessionCtx.subdirectoryHintState,
};
```

(Verify ToolContext type has the field — it likely already does since the orchestrator reads it. If not, add to `src/tool/types.ts`.)

- [ ] **Step 6: Call expandContextReferences in turns route**

In `src/server/routes/turns.ts`, find `runTurnInBackground` (around line 146) and locate the user-message construction (around line 159). Replace:

```typescript
const userMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text }],
};
runtime.sessionDb.saveMessage(sessionId, {
  role: userMessage.role,
  content: userMessage.content,
});
```

with:

```typescript
// M8 T3 — expand @file:path / @url: / @diff / @staged references in the
// user's text BEFORE persisting. Mirrors terminalRepl.ts:1288. Errors are
// inlined as [ERROR: ...] markers in the text; no exception bubbles.
const { expandContextReferences } = await import('../../context/references.js');
const expanded = await expandContextReferences(text, { cwd: runtime.cwd });
const userMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: expanded }],
};
runtime.sessionDb.saveMessage(sessionId, {
  role: userMessage.role,
  content: userMessage.content,
});
```

Hoist the import to the top of the file (Biome will require it):

```typescript
import { expandContextReferences } from '../../context/references.js';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/server/turns.references.test.ts tests/server/sessionContext.subdirHints.test.ts`

Expected: PASS.

- [ ] **Step 8: Full server suite + lint + typecheck**

- [ ] **Step 9: Testing-log + commit + push + sov upgrade**

Commit message: `feat(server): M8 T3 — @file expansion + subdir hints in turns/SessionContext`

---

## Task 4: Skill loading + visibility + GET /skills route

**Goal:** `buildRuntime` calls `loadSkills(...)` and exposes `runtime.skills: SkillRegistry`. `buildSessionToolContext` filters via `inferActiveToolsets` + `filterSkillRegistry` per turn and threads `ToolContext.skills` onto the orchestrator. New `GET /sessions/:id/skills` route returns the filtered registry as JSON for TUI discovery. Closes prereq rows 19 (server-side half) and 20.

**Files:**
- Modify: `src/server/runtime.ts`, `src/server/routes/turns.ts`, `src/server/app.ts`
- Create: `src/server/routes/skills.ts`
- Create: `tests/server/runtime.skills.test.ts`, `tests/server/routes/skills.test.ts`

**Spec / inventory pointers:**
- `src/skills/loader.ts:68-128` — `loadSkills(opts): Promise<SkillRegistry>`.
- `src/skills/visibility.ts:6-55` — `isSkillVisible`, `filterSkillRegistry`, `inferActiveToolsets`.
- `src/skills/commands.ts:9-30` — `buildSkillCommands` (used in T5 for skill-as-slash expansion).
- `src/ui/terminalRepl.ts:476-478` — reference filter call site.

- [ ] **Step 1: Write failing test for runtime.skills**

Create `tests/server/runtime.skills.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — skills loaded (M8 T4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t4-skills-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('runtime.skills populated from bundle-default skills', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    expect(runtime.skills).toBeDefined();
    expect(runtime.skills.skills.length).toBeGreaterThan(0);
    // Verify at least one well-known bundle-default skill is present.
    const skillNames = runtime.skills.skills.map((s) => s.name);
    expect(skillNames).toContain('review'); // bundle-default/skills/review.md
    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Write failing test for GET /skills**

Create `tests/server/routes/skills.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../../src/server/runtime.js';
import { buildAppWithRuntime } from '../../../src/server/app.js';

describe('GET /sessions/:id/skills (M8 T4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t4-route-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('returns filtered skill registry', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const skillsRes = await app.request(`/sessions/${sessionId}/skills`);
    expect(skillsRes.status).toBe(200);
    const body = (await skillsRes.json()) as { skills: Array<{ name: string; whenToUse: string }> };
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills.length).toBeGreaterThan(0);
    expect(body.skills[0].name).toBeDefined();
    expect(body.skills[0].whenToUse).toBeDefined();

    await runtime.dispose();
  });

  test('404 on unknown session id', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const res = await app.request('/sessions/00000000-0000-0000-0000-000000000000/skills');
    expect(res.status).toBe(404);

    await runtime.dispose();
  });

  test('400 on malformed session id', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const res = await app.request('/sessions/not-a-uuid/skills');
    expect(res.status).toBe(400);

    await runtime.dispose();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

- [ ] **Step 4: Add `runtime.skills` to Runtime type**

In `src/server/runtime.ts`:

```typescript
import { loadSkills } from '../skills/loader.js';
import type { SkillRegistry } from '../skills/types.js';
```

Extend `Runtime` type:

```typescript
  /** Loaded skill registry (M8 T4). Populated once at buildRuntime
   *  boot from project, user, and bundle skill roots. Per-call filtering
   *  via inferActiveToolsets + filterSkillRegistry happens in
   *  buildSessionToolContext to narrow visibility to the active toolset. */
  skills: SkillRegistry;
```

- [ ] **Step 5: Load skills in `buildRuntime`**

After `agents` loaded and before `toolCtx` constructed:

```typescript
const skills = await loadSkills({
  cwd: opts.cwd,
  harnessHome,
  ...(bundle ? { bundleRoot: bundle.root } : {}),
});
```

Add `skills` to the return literal.

- [ ] **Step 6: Filter skills per-call in `buildSessionToolContext`**

In `src/server/routes/turns.ts`:

```typescript
import { filterSkillRegistry, inferActiveToolsets } from '../../skills/visibility.js';
```

In `buildSessionToolContext`:

```typescript
const activeToolNames = runtime.toolPool.map((t) => t.name);
const activeToolsets = inferActiveToolsets(activeToolNames);
const filteredSkills = filterSkillRegistry(runtime.skills, activeToolsets, activeToolNames);

return {
  // ... existing fields ...
  skills: filteredSkills,
};
```

- [ ] **Step 7: Create the `skills.ts` route**

Create `src/server/routes/skills.ts`:

```typescript
import { Hono } from 'hono';
import { isValidSessionId } from '../sessionIds.js';
import type { Runtime } from '../runtime.js';
import { filterSkillRegistry, inferActiveToolsets } from '../../skills/visibility.js';

export function skillsRoute(runtime: Runtime): Hono {
  const app = new Hono();
  app.get('/:id/skills', (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const row = runtime.sessionDb.getSession(sessionId);
    if (!row) {
      return c.json({ error: 'not found' }, 404);
    }
    const activeToolNames = runtime.toolPool.map((t) => t.name);
    const activeToolsets = inferActiveToolsets(activeToolNames);
    const filtered = filterSkillRegistry(runtime.skills, activeToolsets, activeToolNames);
    return c.json({
      skills: filtered.skills.map((s) => ({
        name: s.name,
        whenToUse: s.whenToUse,
        description: s.description,
      })),
    });
  });
  return app;
}
```

(Adjust to match the existing route shape in `src/server/routes/sessions.ts` for the Hono app construction convention.)

- [ ] **Step 8: Mount the route in `app.ts`**

In `src/server/app.ts`, locate the route mount section and add:

```typescript
import { skillsRoute } from './routes/skills.js';
// ...
app.route('/sessions', skillsRoute(runtime));
```

- [ ] **Step 9: Run tests + suite + lint + typecheck**

- [ ] **Step 10: Testing-log + commit + push + sov upgrade**

---

## Task 5: TUI `/skillname` dispatch + server-side skill expansion

**Goal:** Go TUI intercepts user input matching a known skill name (from cached `GET /skills` response) and POSTs to `/sessions/:id/turns` with `kind: 'skill'`. Server-side turns route detects `kind === 'skill'`, expands via `expandSkillPrompt`, treats the expanded body as user message text (then runs T3 @file expansion + saveMessage + query as normal). Closes prereq row 19 (client-side half).

**Files:**
- Modify: `src/server/routes/turns.ts`
- Create: `tests/server/turns.skillSlash.test.ts`

**Spec / inventory pointers:**
- `src/skills/loader.ts:130-155` — `expandSkillPrompt(skill, opts)` async expands `{{args}}` placeholders + interpolated shell commands.
- `src/skills/commands.ts:13-30` — `skillToCommand` reference (REPL-side wrapper).

- [ ] **Step 1: Write failing test**

Create `tests/server/turns.skillSlash.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { buildAppWithRuntime } from '../../src/server/app.js';

describe('turns route — skill-as-slash expansion (M8 T5)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t5-skill-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Seed a project-local skill.
    mkdirSync(join(tmpHome, '.harness', 'skills'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.harness', 'skills', 'greet.md'),
      `---\nname: greet\nwhenToUse: when user types /greet\ndescription: Greets the user\n---\nHello {{args}}, nice to meet you.\n`,
    );
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  test('POST /turns with kind:skill expands the skill prompt before saving message', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '/greet Alice', kind: 'skill' }),
    });
    expect(turnRes.status).toBe(202);
    await app.request(`/sessions/${sessionId}/events`).then((r) => r.text());

    const messages = runtime.sessionDb.loadMessages(sessionId);
    const userText = JSON.stringify(messages[0].content);
    expect(userText).toContain('Hello Alice, nice to meet you.');
    expect(userText).not.toContain('/greet'); // raw slash replaced

    await runtime.dispose();
  });

  test('POST /turns with kind:skill + unknown skill returns 400', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);
    const createRes = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '/unknownskill arg', kind: 'skill' }),
    });
    expect(turnRes.status).toBe(400);

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run failing test**

- [ ] **Step 3: Parse `kind: 'skill'` in turns route + dispatch to expansion**

In `src/server/routes/turns.ts`, locate the POST handler. Modify the body schema to accept optional `kind: 'skill'`. When `kind === 'skill'`:

```typescript
import { expandSkillPrompt } from '../../skills/loader.js';
// ...

// Inside the POST handler before runTurnInBackground call:
if (body.kind === 'skill') {
  // Parse the slash command: /name arg1 arg2
  const trimmed = body.text.trim();
  if (!trimmed.startsWith('/')) {
    return c.json({ error: 'kind: skill requires text to start with /' }, 400);
  }
  const space = trimmed.indexOf(' ');
  const skillName = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim();

  const skill = runtime.skills.byName.get(skillName);
  if (!skill) {
    return c.json({ error: `unknown skill: ${skillName}` }, 400);
  }

  const expanded = await expandSkillPrompt(skill, { args });
  // Now treat the expanded text as a normal user turn — feed into runTurnInBackground.
  body.text = expanded;
  // (Do NOT propagate the kind; downstream code treats it as plain text.)
}
```

- [ ] **Step 4: Verify tests pass**

- [ ] **Step 5: Full suite + lint + typecheck**

- [ ] **Step 6: Testing-log + commit + push + sov upgrade**

---

## Task 6: Go TUI — `/skillname` interception + `/expand [N]` dispatch + skill cache

**Goal:** Go TUI fetches `GET /sessions/:id/skills` on session boot, caches the list of skill names. On user input starting with `/`, the TUI checks if the slash matches a known skill — if yes, POSTs to `/sessions/:id/turns` with `kind: 'skill'`. Also intercepts `/expand [N]` to re-render the Nth tool block from the local transcript model. Closes prereq rows 19 (TUI half) and 24.

**Files:**
- Modify: `packages/tui/internal/app/app.go`, `packages/tui/internal/transport/api.go`
- Create: `packages/tui/internal/transport/skills.go`, `packages/tui/internal/transport/skills_test.go`, `packages/tui/internal/app/expand.go`, `packages/tui/internal/app/expand_test.go`

**Spec / inventory pointers:**
- `packages/tui/internal/app/app.go:199-206` — M6 `/compact` interception pattern.
- `packages/tui/internal/app/app.go:526-538` — M6 `compactCmd` dispatch pattern.

- [ ] **Step 1: Write failing Go test for skill cache + interception**

Create `packages/tui/internal/transport/skills_test.go`:

```go
package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetSkills_ReturnsList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"skills": []map[string]string{
				{"name": "greet", "whenToUse": "when user types /greet", "description": "Greets"},
				{"name": "review", "whenToUse": "when user asks for review", "description": ""},
			},
		})
	}))
	defer srv.Close()

	skills, err := GetSkills(context.Background(), srv.URL, "abc-123")
	if err != nil {
		t.Fatalf("GetSkills: %v", err)
	}
	if len(skills) != 2 {
		t.Fatalf("expected 2 skills, got %d", len(skills))
	}
	if skills[0].Name != "greet" {
		t.Fatalf("expected first skill name greet, got %s", skills[0].Name)
	}
}
```

- [ ] **Step 2: Write failing Go test for `/expand [N]`**

Create `packages/tui/internal/app/expand_test.go`:

```go
package app

import "testing"

func TestParseExpandCommand(t *testing.T) {
	cases := []struct {
		input string
		ok    bool
		n     int
	}{
		{"/expand", true, 1},
		{"/expand 2", true, 2},
		{"/expand 10", true, 10},
		{"/expand foo", false, 0},
		{"/expand -1", false, 0},
		{"/expand 0", false, 0},
	}
	for _, tc := range cases {
		n, ok := parseExpandCommand(tc.input)
		if ok != tc.ok || n != tc.n {
			t.Errorf("parseExpandCommand(%q) = %d, %v; want %d, %v", tc.input, n, ok, tc.n, tc.ok)
		}
	}
}
```

- [ ] **Step 3: Run failing tests**

Run: `(cd packages/tui && go test ./internal/transport/... ./internal/app/...)`

Expected: FAIL.

- [ ] **Step 4: Implement `skills.go`**

Create `packages/tui/internal/transport/skills.go`:

```go
package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type Skill struct {
	Name        string `json:"name"`
	WhenToUse   string `json:"whenToUse"`
	Description string `json:"description"`
}

type skillsResponse struct {
	Skills []Skill `json:"skills"`
}

func GetSkills(ctx context.Context, baseURL, sessionID string) ([]Skill, error) {
	url := fmt.Sprintf("%s/sessions/%s/skills", baseURL, sessionID)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GET %s failed: %d %s", url, resp.StatusCode, body)
	}
	var out skillsResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Skills, nil
}
```

- [ ] **Step 5: Implement `expand.go`**

Create `packages/tui/internal/app/expand.go`:

```go
package app

import (
	"strconv"
	"strings"
)

// parseExpandCommand parses "/expand" or "/expand N" → (n, ok).
// Defaults to 1 when no arg. Returns ok=false on non-positive ints or bad args.
func parseExpandCommand(input string) (int, bool) {
	trimmed := strings.TrimSpace(input)
	if !strings.HasPrefix(trimmed, "/expand") {
		return 0, false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "/expand"))
	if rest == "" {
		return 1, true
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}
```

- [ ] **Step 6: Wire `/skillname` interception + `/expand` interception in app.go**

In `packages/tui/internal/app/app.go`, in the input-submit handler (around line 199 where `/compact` is intercepted):

```go
// M8 T6 — /expand [N] interception. Local re-render from transcript ring.
if n, ok := parseExpandCommand(text); ok {
    return m.expandToolBlock(n)
}

// M8 T6 — /skillname interception. If the slash matches a known skill,
// POST as kind:skill so server expands. Otherwise fall through to normal
// input handling.
if strings.HasPrefix(text, "/") {
    space := strings.Index(text, " ")
    name := text[1:]
    if space != -1 {
        name = text[1:space]
    }
    for _, skill := range m.skills {
        if skill.Name == name {
            return m.submitSkillTurn(text)
        }
    }
    // Not a known skill — fall through (may be /compact, /help, or unknown).
}
```

(Add `m.skills []Skill` field on the model; fetch in `Init()` via `GetSkills`.)

Add `submitSkillTurn` and `expandToolBlock` methods. The skill turn submission mirrors the existing normal-turn POST but adds `"kind": "skill"` to the JSON body. The expand method reads from the local ring buffer + re-renders.

(Concrete implementation requires reading more of `app.go`; the implementer should match the existing patterns.)

- [ ] **Step 7: Maintain local ring buffer of tool blocks**

In `app.go`'s SSE handler, when a `tool_result` event arrives, push `{blockSeq, toolName, output}` onto a local slice (cap at 50; pop oldest when full).

- [ ] **Step 8: Run Go tests + TS suite + lint**

```bash
(cd packages/tui && go test ./...)
bun test
bun run lint && bun run typecheck
```

- [ ] **Step 9: Testing-log + commit + push + sov upgrade**

---

## Task 7: Stall detection SSE event + extended session_summary payload

**Goal:** Add `stall_detected` SSE event type to the wire-event union. The turns route maps the `stall_detected` stream event from `query()` into the SSE wire event. Extend `session_summary` SSE event payload with rich `SessionMetrics` fields (tokens, durations, tool counts). Closes prereq rows 21 and 22.

**Files:**
- Modify: `src/server/sessionContext.ts`, `src/server/routes/turns.ts`, `src/server/schema.ts`, `src/agent/sessionDb.ts`
- Create: `tests/server/turns.stallDetected.test.ts`, `tests/server/sessionContext.sessionSummary.test.ts`

**Spec / inventory pointers:**
- `src/review/stall.ts:5-50` — `detectStall`, `TurnSummary`, `StallResult`.
- `src/core/query.ts:391` — existing per-turn `detectStall` call site (emits trace event).
- `src/trace/types.ts:98-104` — existing `stall_detected` trace event shape.
- `src/ui/sessionSummary.ts:8-34` — `SessionMetrics` reference shape.

- [ ] **Step 1: Add `StallDetectedEvent` Zod schema**

In `src/server/schema.ts`, after the existing `SessionSummaryEvent`:

```typescript
export const StallDetectedEvent = BaseEvent.extend({
  type: z.literal('stall_detected'),
  reason: z.string(),
  turn: z.number().int().nonnegative(),
});
```

Add to the `WireEvent` discriminated union.

Extend `SessionSummaryEvent`:

```typescript
export const SessionSummaryEvent = BaseEvent.extend({
  type: z.literal('session_summary'),
  totalDispatched: z.number().int().nonnegative(),
  byAgent: z.record(z.string(), z.number().int().nonnegative()),
  // M8 T7 — extended payload for M9 goodbye-card consumer.
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative().optional(),
    cacheWrite: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative(),
  }).optional(),
  startedAtMs: z.number().optional(),
  endedAtMs: z.number().optional(),
  agentActiveMs: z.number().optional(),
  apiTimeMs: z.number().optional(),
  toolTimeMs: z.number().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  toolOk: z.number().int().nonnegative().optional(),
  toolErr: z.number().int().nonnegative().optional(),
});
```

- [ ] **Step 2: Map `stall_detected` stream event → wire event**

In `src/server/routes/turns.ts`, locate the stream-event mapping (likely `mapStreamEventToServerEvent`). Add a case:

```typescript
case 'stall_detected':
  return {
    type: 'stall_detected',
    seq: bus.nextSeq(),
    sessionId,
    reason: streamEvent.reason,
    turn: streamEvent.turn,
  };
```

(Verify the StreamEvent shape — `src/core/types.ts` lists `stall_detected` as one of the StreamEvent union members; if it's actually emitted as a trace event only, the implementer may need to ADD a StreamEvent emission in `query()` — confirm by grep.)

- [ ] **Step 3: Write failing test for stall detection**

Create `tests/server/turns.stallDetected.test.ts`:

```typescript
// Drive 3 consecutive turns through a custom MockProvider that returns
// only text (no tool calls, no edits, no memory writes) — should trigger
// the "no edits, no decisions, no memory writes for 3 turns" stall.
// Assert: a stall_detected SSE event appears with reason matching.
```

(Full test body follows the m7Full.test.ts pattern; the implementer fleshes out using MockProvider env-flag mode.)

- [ ] **Step 4: Write failing test for extended session_summary**

Create `tests/server/sessionContext.sessionSummary.test.ts`. Asserts the rich payload fields are present on the emitted event.

- [ ] **Step 5: Implement session metrics in sessionDb**

Add `getSessionMetrics(sessionId): { tokens, toolCalls, toolOk, toolErr, agentActiveMs, apiTimeMs, toolTimeMs, startedAtMs, endedAtMs }` accessor to `src/agent/sessionDb.ts`. Reads from the existing token-usage table (from M7 cost fix) + the tool-event table (verify with grep — may need to add a SELECT SUM query).

- [ ] **Step 6: Extend disposeSessionContext to emit the rich payload**

In `src/server/sessionContext.ts`, in the review-summary step:

```typescript
const metrics = runtime.sessionDb.getSessionMetrics(ctx.sessionId);
opts.bus.publish({
  type: 'session_summary',
  seq: opts.bus.nextSeq(),
  sessionId: ctx.sessionId,
  totalDispatched: summary.totalDispatched,
  byAgent: summary.byAgent,
  ...(metrics.tokens ? { tokens: metrics.tokens } : {}),
  ...(metrics.startedAtMs ? { startedAtMs: metrics.startedAtMs } : {}),
  // ... etc.
});
```

- [ ] **Step 7: Tests + suite + lint + typecheck + commit + sov upgrade**

---

## Task 8: Integration smoke + close-out

**Goal:** Drive all nine M8 subsystems through one end-to-end scenario. Flip 9 prereq boxes, close backlog #30, add 7 ADR stubs, write close-out state snapshot, update CLAUDE.md/AGENTS.md.

**Files:**
- Create: `tests/server/m8Full.test.ts`
- Modify: `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, `docs/08-roadmap/backlog/post-phase-13-4.md`, `DECISIONS.md`, `CLAUDE.md`, `AGENTS.md`
- Create: `docs/07-history/state/2026-05-XX.md`

**Spec / inventory pointers:**
- `tests/server/m7Full.test.ts` — M7 integration smoke pattern; M8's smoke follows the same shape.
- `docs/07-history/state/2026-05-15.md` — M7 close-out snapshot; M8 supersedes.

- [ ] **Step 1: Write integration smoke**

Create `tests/server/m8Full.test.ts` driving:
- Router-mode runtime (T1)
- Capture wrap (T2)
- @file expansion in user message (T3)
- Subdir hints injected into tool result (T3)
- Skill-as-slash dispatch (T5)
- GET /skills returns filtered list (T4)
- Stall detection emits SSE (T7)
- Rich session_summary on disposal (T7)
- Tool block ring-buffer-ready (T6) — assert M9 will have access via the local Go transcript

- [ ] **Step 2: Run smoke + suite + lint + typecheck**

- [ ] **Step 3: Flip 9 prereq boxes**

In `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`:
- Row 14 → `[x] (M8 — 2026-05-XX)`
- Row 16 → `[x] (M8 — 2026-05-XX)`
- Row 17 → `[x] (M8 — 2026-05-XX)`
- Row 18 → `[x] (M8 — 2026-05-XX)`
- Row 19 → `[x] (M8 — 2026-05-XX)`
- Row 20 → `[x] (M8 — 2026-05-XX)`
- Row 21 → `[x] (M8 — 2026-05-XX)`
- Row 22 → `[x] (M8 — 2026-05-XX)`
- Row 24 → `[x] (M8 — 2026-05-XX)`

**24/24 prereq boxes are now flipped.** This is the M8 milestone signal.

- [ ] **Step 4: Close backlog #30**

In `docs/08-roadmap/backlog/post-phase-13-4.md`, mark #30 closed with the T1 commit SHA.

- [ ] **Step 5: Add ADR stubs**

In `DECISIONS.md`, add: M8-01, M8-02, M8-03, M8-06, M8-07, M8-08, M8-10.

- [ ] **Step 6: Move old state to archive + write new snapshot**

```bash
mv docs/07-history/state/2026-05-15.md docs/07-history/state/archive/
```

Write new `docs/07-history/state/2026-05-XX.md` covering:
- HEAD chain since M7 close
- Suite delta (~+15 tests likely)
- The 9 boxes flipped, #30 closed
- 7 new ADRs
- "24/24 prereq boxes complete" — M10 parity audit is the next milestone gate
- M9 visual polish is the next coding milestone

- [ ] **Step 7: Update CLAUDE.md / AGENTS.md state pointer + descriptions**

Verify byte-identical with `diff CLAUDE.md AGENTS.md`.

- [ ] **Step 8: Final lint + typecheck + tests**

- [ ] **Step 9: Testing-log + commit + push + sov upgrade**

Two atomic commits per the M7 pattern:
1. `feat(server): M8 T8 — integration smoke for all 9 polish-surfaces subsystems`
2. `docs: M8 close-out — 9 prereq boxes flipped, #30 closed, 24/24 complete, state snapshot`

---

## Self-review check

After completing all 8 tasks, sanity-check:

1. **Spec coverage:** All 9 prereq rows (14, 16, 17, 18, 19, 20, 21, 22, 24) have a task implementing them. ✓
2. **Backlog #30:** Closed in T1 (router specialization); doc updated in T8. ✓
3. **ADRs:** 7 ADR stubs added in T8. M8-04 / M8-05 / M8-09 are scope decisions (noted in snapshot, not promoted to ADRs). ✓
4. **terminalRepl untouched:** No task modifies `src/ui/terminalRepl.ts`. ✓
5. **`--ui tui` stays opt-in:** No default flip. ✓
6. **24/24 prereq boxes:** After M8, every box in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` is `[x]`. M9 visual polish + M10 parity audit are the gates to M11 default flip. ✓
7. **Per-task interactions:** T3's @file expansion runs BEFORE T5's skill expansion path — verify by reading: skill expansion happens in the POST handler, sets `body.text`, then continues to the existing user-message path which includes @file expansion. Confirms: a skill body containing `@file:foo.md` WILL get expanded. ✓
8. **No real-Anthropic dependency:** All tests use mock provider. Hardening pass against real Anthropic runs post-T8. ✓

---

## Post-M8 backlog audit

After T8 ships, run the autonomous real-Anthropic smoke (adapt `scripts/m7-real-smoke.ts` for M8 — likely a new `scripts/m8-real-smoke.ts`). Verify:
- A turn with `@file:` works against real Anthropic (file contents flow through to the model).
- A turn submitted as `kind: skill` (via the TUI's interception simulation) works against real Anthropic.
- A long-running session triggers stall detection appropriately (may require seeding empty turns).
- The rich `session_summary` payload contains real cost/tokens from real Anthropic billing.

Cost estimate: ~$0.005 for the M8 smoke (a few short turns; one with a moderate `@file` expansion).

Hardening findings → file as backlog items in `docs/08-roadmap/backlog/post-phase-13-4.md` per the M7 hardening precedent.
