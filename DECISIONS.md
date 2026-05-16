# Decisions

This file records runtime-local design choices. Larger product and architecture ADRs still live in `~/code/sovereign-ai-docs/`.

## ADR M8-01 — Router-mode construction lives in `buildRuntime`, not `resolveProvider`

Decision: When `opts.provider === 'router'` (or `userSettings.defaultProvider === 'router'`), `buildRuntime` constructs the `RouterProvider` explicitly — wrapping the configured local + frontier providers — rather than routing through `resolveProvider()`. The router resolved-provider envelope advertises `transport.name === 'router'`, `metadata.provider === 'router'`, and `metadata.localProvider` / `metadata.frontierProvider` carry the underlying provider names. The `routerAuditLogger` is constructed alongside and closed before `mcpClientPool.shutdown()` inside `runtime.dispose()`.

Rationale: `resolveProvider()` is a single-provider resolver — it returns one `ResolvedProvider` from one provider name. The router wraps two providers (cheap local + expensive frontier) and dispatches per call, so it cannot be expressed through a single resolveProvider call. Mirrors `src/ui/terminalRepl.ts:238-292`. The subagent default specialization (closing backlog #30) lives in the same construction site so child agents launched from a router-mode parent get `defaultProvider: routerCfg.frontierProvider` instead of the literal `'router'` string (which would fail to resolve in the child).

Status: implemented (M8 — `49ed104` (T1 — router-mode construction + subagent default specialization + audit-logger close in dispose order)). Plan: `docs/plans/2026-05-16-phase-16-1-m8-polish-surfaces.md`. Backlog item #30 closed in the same commit.

## ADR M8-02 — Capture / replay fixture wraps the provider + tool pool, mutex-guarded

Decision: `opts.captureFixturePath` wraps the resolved provider in `CapturingProvider` and the tool pool via `wrapToolsForCapture`, mirroring `src/ui/terminalRepl.ts:728-740`. The sink is finalized inside `runtime.dispose()` before `mcpClientPool.shutdown()` so the fixture write succeeds even if MCP teardown later throws. `opts.replayFixturePath` swaps the resolved provider for `ReplayProvider` and wraps the tool pool via `wrapToolsForReplay`; the replay path short-circuits provider preflight (no network round-trip happens). Setting both `captureFixturePath` and `replayFixturePath` throws — the two modes are mutually exclusive.

Rationale: The capture sink needs to mirror BOTH the provider stream events and the tool results (otherwise replay can't reproduce the turn). Wrapping is per-runtime, not per-session, because the sink's `meta.provider` / `meta.model` are runtime-level; the fixture's `meta.sessionId` is set to `'pending'` at construction because the session id is minted per-POST and capture is single-session. The fixture write is best-effort — errors log to stderr but don't re-throw so a capture failure doesn't mask the primary disposal outcome.

Status: implemented (M8 — `912379b` (T2 — capture/replay wiring in buildRuntime + dispose-time fixture write + mutex guard)). Plan: `docs/plans/2026-05-16-phase-16-1-m8-polish-surfaces.md`.

## ADR M8-03 — `@file:` expansion runs in the route, before persistence and skill-as-slash composes with it

Decision: `runTurnInBackground` in `src/server/routes/turns.ts` calls `expandContextReferences(text, { cwd: runtime.cwd })` BEFORE `sessionDb.saveMessage`. The expanded text is what lands in the messages table AND what the model sees, so resume reconstructs the exact same context the original turn ran against. `expandContextReferences` is the same helper terminalRepl uses (`src/ui/terminalRepl.ts:1288`) and inlines failures as `[ERROR: ...]` markers rather than throwing. When the turns route handles `kind: 'skill'`, skill expansion runs FIRST (via `expandSkillPrompt`); the expanded skill body is then fed into the same `expandContextReferences` hop, so a skill template containing `@file:foo.md` gets the file inlined the same way a hand-typed prompt would.

Rationale: Persisting the raw `@file:` reference and expanding at query-time would break resume — a resumed session loading old messages would never re-expand. Persisting the expanded text means the model context is stable across the original turn and any subsequent resume. The pre-skill-expansion ordering composes naturally: skill template ⊃ `@file:` token, so file expansion runs over the skill's output. Subdirectory hints (M8 row 18) follow the same logic at the orchestrator's `appendSubdirectoryHints` site — per-session `SubdirectoryHintState` keeps each ancestor directory's `AGENTS.md`/`CONTEXT.md`/`.cursorrules` files appended at most once per session.

Status: implemented (M8 — `c9da130` (T3 — @file expansion in turns route + per-session subdirectory hint state on SessionContext)). Plan: `docs/plans/2026-05-16-phase-16-1-m8-polish-surfaces.md`.

## ADR M8-06 — Skill registry loads at boot; per-call filter is per-turn (or per-request for GET /skills)

Decision: `runtime.skills` is the UNFILTERED skill registry loaded once at `buildRuntime` from project (`.harness/skills/`), user (`$HARNESS_HOME/skills/`), and bundle roots. Per-turn filtering — `filterSkillRegistry(runtime.skills, activeToolsets, activeToolNames)` — happens in `buildSessionToolContext` so the orchestrator's `ToolContext.skills` view matches the active toolset. The `GET /sessions/:id/skills` route runs the same filter per request. The `kind: 'skill'` byName lookup in the POST /turns handler reads `runtime.skills.byName` UNFILTERED — a user dispatching `/skillname` must be able to invoke a skill even if it's gated for a different toolset (mirroring terminalRepl's `/skillname` semantics).

Rationale: Filtering at boot would force the byName lookup to also filter (or risk a UX surprise where `/foo` works only on the right toolset). Keeping the registry unfiltered on Runtime preserves the byName invariant; filtering per turn keeps the model's view of available skills accurate. The two filter callers (turns route + skills route) compute the same projection because both derive from `runtime.toolPool` — symmetric with terminalRepl which filters per turn at `src/ui/terminalRepl.ts:476-478`.

Status: implemented (M8 — `abcf940` (T4 — skill loading at boot + GET /skills route + per-turn filter in buildSessionToolContext) + `2b9d6f2` (T5 — kind:'skill' byName dispatch + expandSkillPrompt before saveMessage)). Plan: `docs/plans/2026-05-16-phase-16-1-m8-polish-surfaces.md`.

## ADR M8-07 — TUI skill cache + `/skillname` interception is Go-side; the wire is `kind: 'skill'`

Decision: The Go TUI fetches `GET /sessions/:id/skills` once per session to populate an in-memory skill cache (name → metadata). When the user types `/skillname args`, the TUI parses the leading slash, checks the cache, and POSTs to `/sessions/:id/turns` with `{ text: '/skillname args', kind: 'skill' }`. The server's POST handler dispatches via `runtime.skills.byName.get(skillName)` → `expandSkillPrompt(skill, { args })`, then continues into the regular turn loop. The TUI ring buffer holds the most recent tool blocks so `/expand [N]` can re-render an earlier block without a server round-trip.

Rationale: Skill-as-slash needs server-side template expansion (skill bodies live in the bundle/project file tree the server walks). But the slash interception itself — turning `/greet` into the skill body before sending — needs client-side knowledge of what's a skill vs. what's a runtime slash command. Splitting at the wire boundary keeps both sides cohesive: the server owns expansion, the TUI owns intercept-and-tag. The same TUI cache feeds `/expand [N]` by keeping a ring of tool blocks indexed by the live transcript position; no server change was needed to support the expand registry (M8 row 24).

Status: implemented (M8 — `b9fee79` (T6 — TUI /skillname interception + /expand dispatch + skill cache fetch)). Plan: `docs/plans/2026-05-16-phase-16-1-m8-polish-surfaces.md`.

## ADR M8-08 — Stall detection rides the trace recorder; new SSE event added to the wire

Decision: `query()` emits a `stall_detected` trace event when the per-turn `detectStall` sliding-window flags a 3-iteration window with no progress (no edits, no decisions, no memory writes — or repeated tool errors). The turns route's `traceRecorder` closure decorates the trace write so it ALSO publishes a typed `stall_detected` SSE wire event on the per-turn bus. The wire event carries `{ type, seq, sessionId, reason, turn }`. This is the SAME pattern other trace events use — only `stall_detected` has a wire counterpart today because the others (turn_start, provider_request, tool_use_start, etc.) already have purpose-built wire events. Advisory only: the turn continues normally; the TUI surfaces it as a soft warning the user can act on.

Rationale: Option (c) from the M8 T7 brief — least invasive. The alternative — adding a new `StreamEvent` type and emitting from `query()` — would touch the StreamEvent union, every provider, and every consumer. Riding the trace recorder localizes the change to the route layer. The trace event itself is the source of truth (a single `query()` emission); the wire event is a projection for the TUI consumer.

Status: implemented (M8 — `3366b91` (T7 — stall_detected SSE event + rich session_summary payload)). Plan: `docs/plans/2026-05-16-phase-16-1-m8-polish-surfaces.md`.

## ADR M8-10 — Rich `session_summary` payload extends, doesn't replace, the M7 shape

Decision: The `session_summary` SSE event emitted by `disposeSessionContext` on bus-attached disposal carries the M7 base fields (`totalDispatched`, `byAgent`) PLUS optional M8 extension fields: `tokens.{input, output, cacheRead?, cacheWrite?, estimatedCostUsd}`, `toolCalls`, `toolOk`, `toolErr`, `startedAtMs?`, `endedAtMs?`, `agentActiveMs?`, `apiTimeMs?`, `toolTimeMs?`. The extension fields are populated from `runtime.sessionDb.getSessionMetrics(sessionId)` — a new accessor that reads the per-session token-usage table (populated by `recordTokenUsage` in the turns route after the M7 cost fix) and scans the persisted message list for `tool_use` blocks. Durations are left optional (no DB-side tracking yet — server-side TODO until M9 polish). The `getSessionMetrics` call is wrapped in a best-effort closure so a metric read failure still emits the M7 base shape; the wire schema marks all M8 fields optional so M7-vintage consumers parse the event unchanged.

Rationale: The M9 goodbye-card renderer needs cost + tool counts to display a meaningful "session ended" surface. Synthesizing these fields client-side would require the TUI to track token usage and tool calls separately from the server — duplicate observation surface. The server already has all the data in `sessionDb`; exposing a single rich payload at disposal is the minimal change. Optional extension fields preserve backward compatibility with any M7-vintage consumer of the wire event (the schema test enforces this).

Status: implemented (M8 — `3366b91` (T7 — `sessionDb.getSessionMetrics` accessor + rich `session_summary` payload + wire schema extension)). Plan: `docs/plans/2026-05-16-phase-16-1-m8-polish-surfaces.md`.

## ADR M7-01 — Per-session subsystems live in a Map on Runtime

Decision: M7 introduces a per-session subsystem cluster — trace writer, learning observer, review manager, trajectory metadata — that lives on `SessionContext`, materialized in `Runtime.sessionContexts: Map<sessionId, SessionContext>`. The map is built lazily via `runtime.getSessionContext(sessionId)` (constructs on first reference, caches afterwards) and torn down via `runtime.disposeSession(sessionId)` (runs the disposal sequence; removes from map). The turns route fetches the context per turn and threads its members onto the per-turn `ToolContext` so `query()` consumers (orchestrator, scheduler, tools) see them through their existing optional-chain reads.

Rationale: M3–M6 fields on `Runtime` were process-global singletons. M7's per-session subsystems are per-session by design — trace files are named by sessionId, learning observers wrap a per-cwd project identity, review managers carry per-session dispatch counters, and trajectory records are emitted per-session at disposal. Hoisting them onto a process-global `Runtime` field would either force every consumer to take a sessionId argument (intrusive) or invite cross-session leakage (correctness hazard). The Map keeps construction local to where it's needed and gives `disposeSession` a clean teardown contract independent of `runtime.dispose()`. Multi-session UX (the future M8/M9 surface) becomes mechanically possible without rewiring — each session id materializes its own subsystem cluster on first reference.

Status: implemented (M7 — `7a333cc` (T3 — SessionContext + per-session trace writer) + `345dcad` (T4 — trajectory metadata + disposal-time write) + `7a39748` (T5 — learning observer) + `40032e1` (T6 — review manager + disposal-time session_summary)). Plan: `docs/plans/2026-05-15-phase-16-1-m7-hermes-layer.md`.

## ADR M7-02 — Trace writer rebuilt on compaction

Decision: When M6's compaction creates a new child session id mid-turn, the turns route does NOT reuse the parent's `TraceWriter` for the child. The parent's writer continues to receive any events emitted before the pivot; after `compaction_complete` lands and `sessionId` reassigns to the child id, the turns route's next `runtime.getSessionContext(childId)` call constructs a fresh `SessionContext` (with a fresh trace writer) for the child. The parent's writer remains open until the parent session is explicitly disposed (or `runtime.dispose()` walks the map at shutdown).

Rationale: trace files are named by sessionId — `<harnessHome>/traces/<sessionId>.jsonl`. Reusing the parent's writer for the child would write the child's events into the parent's file under the wrong session attribution. `sov trace show <childId>` would find nothing; `sov trace show <parentId>` would surface child events with the parent's session header — useless for forensic replay. Per-session writers also bound resource cost: each child gets a separate `WriteStream`; the parent's stays open only as long as anyone references it. The disposal contract picks up the cleanup at session end.

Status: implemented (M7 — `7a333cc` (T3 — trace writer per-session, registry-cached, disposed at session end)). Plan: `docs/plans/2026-05-15-phase-16-1-m7-hermes-layer.md`.

## ADR M7-03 — Trajectory writes on session disposal, not per-turn

Decision: `tryWriteTrajectory()` fires from `disposeSessionContext()` (called by `runtime.disposeSession()`), not from each turn's terminal event. The full session history (per `sessionDb.loadMessages(sessionId)`) is written as one ShareGPT-shaped JSONL record into `<artifactsRoot>/trajectories/{samples,failed}.jsonl`. Bucket selection by `trajectoryMetadata.terminalReason` (default `'completed'`; set to `'error'` by the turns route on `turn_error`). Redaction applied at write per Invariant #15. Empty-history sessions short-circuit without writing.

Rationale: trajectory's contract is "full session as one JSON record" (per the Sovereign moat brief — the corpus is per-session, not per-turn). Per-turn writes would either overwrite a file the user expects to grow monotonically (drift from what the consumer reads), or fragment one session across N partial records the consumer would have to reassemble (defeats the ShareGPT shape). Disposal-driven writes match how terminalRepl flushes its trajectory today (`src/ui/terminalRepl.ts:1755-1820`). Trade-off accepted: process crashes lose trajectories for sessions that haven't been disposed — mitigated by `tryWriteTrajectory()` being fire-and-forget so disposal itself completes even if the write fails, and by the operational pattern that crashes are rare relative to graceful end-of-session disposal.

Status: implemented (M7 — `345dcad` (T4 — trajectory writes at disposal) + `73483e5` (T4 cleanup — dropped unused `terminalError`)). Plan: `docs/plans/2026-05-15-phase-16-1-m7-hermes-layer.md`.

## ADR M7-05 — Review manager same lifecycle as trace; scheduler-dispatched

Decision: Per-session `ReviewManager` is constructed in `buildSessionContext` alongside the trace writer and learning observer, threaded onto the per-turn `ToolContext.reviewManager`. The existing in-process triggers (orchestrator's `toolCtx.reviewManager?.onToolIteration(...)` at `src/core/query.ts:352`, scheduler's `parentToolContext.reviewManager?.onChildCompletion(...)` at `src/runtime/scheduler.ts:326`, and the turns route's `sessionCtx.reviewManager?.onUserTurn(sessionId)` added in M7 T6 follow-up) fire when the field is populated. Counter-tripping dispatches route through `runReviewFork` (via `runtime.subagentScheduler.delegate(...)`) into `memory_propose` / `skill_propose` proposals written under `<harnessHome>/review/pending/`. At session disposal, `ctx.reviewAbortController.abort()` fires unconditionally and `getDispatchSummary()` emits as a `session_summary` SSE event onto the disposal bus when present.

Rationale: `ReviewManager` dispatches fire-and-forget sub-agents through the `SubagentScheduler` that already lives on `Runtime` from M5. The construction needs handles to trace + trajectory paths and the per-project instincts dir — which all exist within `SessionContext` once T3+T4+T5 land. Keeping `ReviewManager` on the same per-session lifecycle as the trace writer means a single disposal pathway (`disposeSessionContext`) tears down all four subsystems in a deterministic order. The existing call sites in the orchestrator and scheduler already optional-chain on the field — M7 T6 just needed to populate it on the `ToolContext` and on the dispatch-time `parentToolContext` snapshot the scheduler reads. Review/learning observe via direct ToolContext call-sites, NOT via the `DaemonEventBus` (see ADR M7-06).

Status: implemented (M7 — `40032e1` (T6 — ReviewManager wired into SessionContext + ToolContext + disposal summary) + `e2f6492` (T6 follow-up — `onUserTurn` wired into turns route + dropped `as ToolContext` cast)). Plan: `docs/plans/2026-05-15-phase-16-1-m7-hermes-layer.md`.

## ADR M7-06 — `DaemonEventBus` is plumbing-only in M7

Decision: M7 T2 closes backlog item #28 by constructing a `DaemonEventBus` inside `buildRuntime` and passing it to `new TaskManager({ store, scheduler, bus })`. The bus is exposed as `runtime.daemonEventBus` so cross-process subscribers can attach in the future. No subscriber is wired inside the server process in M7 itself — review/learning observe via direct optional-chain reads on `ToolContext.reviewManager` / `ToolContext.learningObserver` after every tool call (the call sites already in `src/core/query.ts` and `src/core/orchestrator.ts`). The bus is plumbing for the future daemon-mode (and any future cross-process consumer that needs the TaskManager lifecycle stream).

Rationale: M5 already exposed `TaskManager` lifecycle events but the server-mode `TaskManager` had no bus subscriber wiring, so the events went nowhere — closing #28 was the natural M7 home because the review/learning subsystems landing in the same milestone are the prospective consumers. But wiring an in-process subscriber inside the same `buildRuntime` would duplicate the direct-call observation pattern review/learning already use, with two complete observation paths to keep in sync going forward. The direct-call pattern is what terminalRepl uses today; staying with it preserves parity. Treating the bus as plumbing-only lets future daemon-mode subscribers attach without rewiring the construction, and unblocks any future Phase 16.0a daemon-mode resurrection without circling back through `buildRuntime`.

Status: implemented (M7 — `bfaeaad` (T2 — DaemonEventBus constructed in buildRuntime, threaded into TaskManager, exposed on `Runtime.daemonEventBus`)). Plan: `docs/plans/2026-05-15-phase-16-1-m7-hermes-layer.md`. Backlog item #28 closed in the same commit.

## ADR M7-08 — `runtime.dispose()` order — per-session → MCP → approvals → sessionDb

Decision: When `runtime.dispose()` is called (process shutdown), the teardown runs in a specific order:

1. **Walk `sessionContexts` Map** — call `disposeSessionContext(ctx, { runtime })` on each registered session. Each disposal closes the trace writer, drains the learning observer, writes the trajectory, aborts the review controller, and emits a logged `session_summary` (no bus at shutdown — the SSE consumer has already disconnected).
2. **Shut down `mcpClientPool`** — terminate stdio MCP child processes.
3. **Close `approvalQueue`** — dispose any pending approval promises.
4. **Close `sessionDb`** — release the SQLite connection.

The same order applies even when `disposeSession(sessionId)` is called for a specific session (steps 1 + the per-session subsystem teardown sequence within `disposeSessionContext`).

Rationale: trajectory writes inside step 1 read messages from `sessionDb` — closing the database first would break the write. MCP child processes may be referenced by in-flight tool calls; closing them mid-disposal could surface as a tool-call failure that interferes with the trajectory write. Approval queue may have pending Promises waiting on bus closure; closing it last ensures any in-flight approval rejects cleanly. Crashing on step N still leaves the prior steps' data intact per the fire-and-forget invariants on trajectory/trace writes — the per-step ordering is about graceful disposal, not crash safety.

Status: implemented (M7 — `7a333cc` (T3 — initial dispose order set) + `345dcad` (T4 — trajectory step inserted before MCP/approvals/sessionDb)). Plan: `docs/plans/2026-05-15-phase-16-1-m7-hermes-layer.md`.

## ADR M6-01 — Compaction creates a new session id; client tracks it

Decision: every compaction (proactive, overflow recovery, or explicit `/compact`) creates a fresh child session id via `compactSession`. The new id surfaces to the client through two channels: (a) the `compaction_complete` SSE event (`{ sessionId: parent, activeSessionId: child, summary, estimatedBeforeTokens, estimatedAfterTokens }`) emitted onto the parent session's bus during background turns, and (b) the JSON response body of `POST /sessions/:id/compact` (`{ activeSessionId, parentSessionId, summary, ... }`). The TUI updates its in-memory `m.sessionID` on receiving either signal so subsequent POSTs (turns, approvals, further compactions) route to the new child id.

Rationale: mirrors terminalRepl's in-process `activeSessionId` swap (`src/ui/terminalRepl.ts:1720-1754`). SessionDb already persists parent→child lineage via `recordCompactionLineage` (`src/agent/sessionDb.ts:479`), so a future server-side helper could resolve `--resume <oldId>` to the latest descendant if user demand surfaces — deferred for M6 (out of scope). Treating compaction as a fresh-session hop keeps the persisted timeline tractable: each child carries the summarized parent context as its seed, and the parent row stays immutable for audit. The alternative — mutating the parent's history in place — would invalidate any in-flight subscribers and tangle the SessionDb's append-only model.

Status: implemented (M6 — proactive `15ca6cf` (T3) + overflow `a977c86` (T4) + explicit `b4fc7b2` (T5) + Go TUI client `59e5d9f` (T6)). Plan: `docs/plans/2026-05-14-phase-16-1-m6-long-session.md`.

## ADR M6-02 — Single retry on context-overflow; second overflow surfaces as `turn_error`

Decision: when the first model call inside `runTurnInBackground` surfaces an `isContextOverflowError(...)` (either thrown by the provider stream and captured into `Terminal { reason: 'error', error }`, or otherwise present on the returned Terminal), the route runs `runtime.compact()`, publishes `compaction_complete`, reassigns `sessionId` to the new child id, and re-runs the SAME turn ONCE against the post-compaction session. If the retry's main call ALSO surfaces an overflow, the route does NOT compact + retry a second time — the overflow surfaces as `turn_error` (the same surface non-overflow errors take). The proactive block (which fires before any model call) and the recovery branch (which fires after the first overflow) operate on independent budgets — a proactive compaction earlier in the same turn does NOT prevent the recovery branch from firing, so a single turn can emit TWO `compaction_complete` events.

Rationale: matches the proven shape in `src/ui/terminalRepl.ts:1659-1675`. The `retriedAfterCompact` flag in terminalRepl guards ONLY the recovery retry — proactive + recovery interact independently in the canonical implementation. Two-retry loops mask deeper bugs (a runaway summarizer that emits the same context every time would loop indefinitely without the cap) and increase blast radius — one retry is the established contract. The post-recovery overflow is a distinct failure surface ("compaction didn't yield enough headroom") that the TUI should not treat as a normal turn end; surfacing it as `turn_error` keeps the wire shape honest about what happened. Future user demand for a configurable retry count can land via the existing settings cascade without changing the contract.

Status: implemented (M6 — `a977c86` (T4) + `e464ffa` (T4 cleanup pinned the proactive+recovery interaction)). Plan: `docs/plans/2026-05-14-phase-16-1-m6-long-session.md`.

## ADR M6-03 — `POST /sessions/:id/compact` is synchronous; returns `CompactResult` JSON inline

Decision: the explicit-compaction route runs `runtime.compact()` inline (no SSE-driven background flow) and returns 200 with `{ activeSessionId, parentSessionId, summary, estimatedBeforeTokens, estimatedAfterTokens, usedAuxiliary }` once `compactSession` resolves. Errors return JSON-shaped responses: 400 for malformed `:id`, 404 for unknown session id (`{ error: 'not found' }` to match the sibling `sessions.ts` envelope), 500 for downstream summarizer failures (`{ error: <thrown message> }`). No `compaction_complete` SSE event fires for this path — the JSON response IS the notification.

Rationale: the TUI's `/compact` is a user-blocking action; the user expects the prompt to wait. SSE-driven flow adds complexity without payoff for a synchronous user verb — the caller would have to dedupe a single user action across two transports and the TUI's pivot logic would need to handle field-ordering ambiguity (which arrives first across the HTTP body and the SSE event?). The synchronous shape mirrors the M5 approval-route's surface (POST returns 200 once the queue resolves), so the TUI's request-then-pivot pattern stays consistent across the two M5/M6 verbs. Auto-compaction during background turns (T3 proactive + T4 recovery) is a different surface — those run inside `runTurnInBackground` and need the SSE bridge so the open SSE subscriber learns about the session-id pivot mid-turn.

Status: implemented (M6 — `b4fc7b2` (T5) + `8bc4a22` (T5 cleanup pinned the 400/404/500 envelopes)). Plan: `docs/plans/2026-05-14-phase-16-1-m6-long-session.md`.

## ADR M5-01 — Non-interactive hooks consent in `--ui tui`

Decision: when a hook command from `~/.harness/settings.json` is not already recorded in `~/.harness/shell-hooks-allowlist.json`, the server-mode consent checker denies it without prompting. Users pre-consent each command once via `sov --ui repl` (which owns a TTY and runs the first-use modal); subsequent `--ui tui` boots read the persisted decision and fire the hook through the cached `allow`.

Rationale: the HTTP+SSE server doesn't own a TTY — there's no interactive surface to render a consent modal against. A `--ui tui` boot needs to make a binary choice the moment the hook would fire: prompt where the user can't see it (broken), block the turn until they switch to repl (worse UX), or deny-by-default (chosen). Deny-by-default preserves Invariant #13 (first-use TTY consent) without bolting a faux-modal onto a surface that can't carry it. The runner treats a denied hook as inert (not a turn-blocking error), so a misconfigured hook degrades visibility (stderr line) rather than usability.

Status: implemented (M5 — commits `3bbc83e` (T1) + `d5133eb` (T2)). Spec §13. Plan: `docs/plans/2026-05-14-phase-16-1-m5-user-noticed.md`.

## ADR M5-02 — Approval timeout default 60 s

Decision: `ApprovalQueue.createPending(requestId, timeoutMs)` is called with a 60 000 ms (60 second) TTL in `serverAsk`. On timeout the queue resolves with `{ approved: false, reason: 'timeout' }` and the bridge maps that to `'deny'` for `canUseTool`. The 60s value is hard-coded in `src/server/runtime.ts`'s `PERMISSION_REQUEST_TIMEOUT_MS` constant; it is not user-configurable in M5.

Rationale: 60s is long enough that a user reading a permission prompt has time to weigh the call, short enough that a forgotten / accidentally-closed TUI doesn't park a turn indefinitely. The deny-on-timeout semantics fail safe — a user who walks away from a prompt never accidentally grants a tool. User-configurability (per-mode TTL, per-tool TTL, "no timeout" mode) is a follow-up: M5 ships the constant + an obvious config seam; the cascade lands when there's a user signal that 60s is wrong for their workflow.

Status: implemented (M5 — commits `b844930` (T3) + `f63c8c6` (T5)). Spec §5. Plan: `docs/plans/2026-05-14-phase-16-1-m5-user-noticed.md`.

## ADR M5-03 — Defer sub-agent activity indicator to M9

Decision: M5 wires `SubagentScheduler` + `LaneSemaphores` + `writeLock` + `TaskManager` through `buildRuntime` and threads them onto `toolContext` so `AgentTool` / `task_create` dispatch through the live sub-agent runtime — but the Go TUI does NOT add a status-line "child running" widget, a sub-agent transcript pane, or any visual signal that a child session is in flight. The functional path is complete; the visual signal is M9's concern.

Rationale: M5 is the "user-noticed group" — the surfaces a user notices when they're missing (hooks fire, permission modal renders, child sessions actually run). A status indicator falls in the "user notices when it's polished" category, which is exactly the M9 visual-polish brief (tool cards, markdown rendering, syntax highlight, slash autocomplete, mouse, theme switch, child activity). Splitting the work this way keeps M5's surface area focused on the functional gates and lets M9 land the indicator alongside the other polish surfaces it pairs with naturally. Trade-off accepted: a user dispatching a sub-agent through `--ui tui` between M5 and M9 sees the parent paused without an explicit "child running" cue; SSE events from the child do not render at all.

Status: deferred to M9 (M5 — commits `1ded093` (T6) + `169c1dc` (T7) + `ba2d454` (T8)). Spec §13. Plan: `docs/plans/2026-05-14-phase-16-1-m5-user-noticed.md`.

## ADR M4-01 — Hydrate-then-subscribe for `--resume --ui tui`

Decision: TUI fetches the prior message backlog via `GET /sessions/:id/messages` before subscribing to the SSE stream. Discarded alternative: embedding the backlog in a `session_resumed` SSE event.

Rationale: SSE stays lean for live events; HTTP fetch can retry/paginate independently; shape matches the `loadMessages()` SessionDb API; cleaner fit for Bubble Tea's Elm-loop (single `messagesFetchedMsg` vs variable-shape SSE event).

Status: implemented (M4 — commits `0d4d94a`, `aa66a89`).

## 2026-05-06 - Phase 13.3 — Background review daemon: five design choices

Phase 13.3 ships a counter-driven review daemon that proposes memory and skill changes in the background. Several choices were non-obvious enough to record:

1. **REVIEW_ONLY_TOOLS: hard pool-separation, not description-based hints.** The first design used a description string ("this tool is for review sub-agents only") to discourage the main agent from calling `memory_propose` / `skill_propose`. Replaced in commit ec21277 (A2) with hard exclusion at the pool level: `REVIEW_ONLY_TOOLS` is a separate export in `src/tool/registry.ts` that `assembleToolPool()` never includes. The tokens from both tool schemas (~530 tokens) are freed from the main agent's context as a side-effect. The `tools.main-agent-excludes-propose-tools` semantic test pins this invariant so a refactor can't accidentally re-add them. Lesson: description-based gates are invisible to static analysis; pool-level gates are enforceable.

2. **`onChildCompletion` throttling with a trivial-child skip (A1) + temporal lockout (A3).** The naive design dispatches a review fork after every child completion. Two problems: (a) trivial children (0 tool calls + 0 user turns — no real content to learn from) would waste a fork slot; (b) burst delegations (the parent spawns 5 children in quick succession) would fire 5 review forks almost simultaneously, exceeding the review daemon's intended cadence. A1 skips the dispatch when the child is trivial. A3 tracks the last-dispatch timestamp and drops dispatches within `minIntervalMs` (30s default). Both are in `ReviewManager` and both guards are configurable; the temporal lockout bypass (`/review consolidate`) is intentionally explicit.

3. **Soft enforcement for `allowedTools` in review agents, hard enforcement at pool level.** The review agents declare `allowedTools: [memory_propose]` (or `skill_propose`) in their frontmatter. The scheduler's `filterToolsForChild` intersects the augmented pool with this list, which naturally surfaces the right propose tool to the right agent. We don't need to add `memory_propose` and `skill_propose` to `SUBAGENT_EXCLUDED_TOOLS` because they're not in the main agent's pool at all — there's nothing to exclude. The original implementation mistakenly added them to `SUBAGENT_EXCLUDED_TOOLS`, which blocked review forks themselves from using their own tools (commit `9296d54` reverted this). Rule: exclusion set = "tools the parent can see that children shouldn't"; REVIEW_ONLY_TOOLS = "tools no one in the main-agent lineage should see."

4. **Phantom row strategy: three-layer defense (B4 abort + Fix #3 filter + close-out sweep).** Review forks that are aborted before completing leave a row in the `sessions` table with no terminal event. Three mitigations at different levels: B4 calls `ReviewManager.cancelAll()` on `session_end` to reduce the rate of new orphans; Fix #3 filters `/review activity` to only show sessions with a terminal event (so phantoms don't appear in the UI); the close-out sweep (`e516a43`) runs a best-effort `DELETE` on startup for rows with `task_type = 'review'` that have no terminal record older than 60 seconds. No single layer is sufficient alone — the B4 guard doesn't help if the process is killed; the Fix #3 filter doesn't clean the DB; the startup sweep would miss live in-flight sessions.

5. **Trajectory location split: bundle path vs. `harnessHome` (B2).** Prior to B2, all trajectories went to `<bundle>/state/artifacts/trajectories/` regardless of which bundle was active. For real bundles (user-authored) this is correct — trajectories are bundle-specific training data. For the shipped default bundle (`bundle-default/`), writing there would accumulate user-session data inside the runtime install directory, polluting `git status` and surviving `sov upgrade` (the upgrade wipes and reinstalls, but `bundle-default/state/` is in the repo and would be clobbered). Fix: `isDefaultBundlePath()` detects the default bundle and redirects to `<harnessHome>/trajectories/`. The same redirect applies to review proposals. This is a divergence from the "bundle owns state" principle — acceptable because the default bundle is a vendor-owned template, not a user-owned bundle.

## 2026-05-05 - `sov upgrade` now purges Bun cache by default

Reversal of the 2026-05-04 default. Original rationale was: "punishing users who have other globally-installed Bun packages by wiping their manifest cache is too aggressive — make the cache wipe explicit." After three real-world recurrences (most recently a Phase 13 user who ran `sov upgrade` four times before realizing it was silently re-installing the same pre-Phase-13 SHA — the cached `URL → SHA` mapping kept winning), the calculus has flipped:

- **Silent stale install is strictly worse than a manifest cache wipe.** The wiped cache is regenerable (Bun re-fetches manifests on the next install of each package). The stale install is functionally a broken upgrade — the user thinks they're on master and they're not.
- **Other-package cost is one-time and small.** Bun's manifest cache is opaque hashes, not source. Re-fetching means each subsequent `bun install` runs ~1-3 s slower until the cache repopulates. Not a meaningful penalty.
- **Surgical purge wasn't viable.** Cache files are named with content hashes (`<hash>.npm`); identifying which entry belongs to a specific git URL would require unpacking each `.npm` tarball or replicating Bun's internal hash-of-URL function. Brittle.

So `sov upgrade` now wipes `~/.bun/install/cache/` by default. The previous `--purge-cache` flag is preserved as a no-op (back-compat) and a new `--keep-cache` flag opts back into the old behavior. The internal helper `shouldPurgeCache(opts)` resolves the decision: `keepCache: true` wins over `purgeCache: true`; both default to a purge.

Rejected alternative: post-install verification + auto-retry on no-op. Would require comparing pre-install vs. post-install SHAs, but Bun strips `.git/` from extracted git installs so we'd need to bake a SHA stamp into the install (build step) or parse `~/.bun/install/global/bun.lock` (Bun-internal format we don't want to depend on). Switching the default is a one-line semantic change that achieves the same reliability without taking on Bun-version-specific maintenance.

## 2026-05-05 - Phase 13 — Sub-agent runtime: five design choices

The sub-agent surface is mostly mechanical — registry, scheduler, AgentTool wrapper. A few choices were non-obvious enough to record:

1. **AgentRunner doesn't subsume the REPL's inline `query()` callsite.** The build plan calls for AgentRunner to be "used by CLI, sub-agents, background review, scheduled missions, daemon." The CLI part isn't worth the refactor cost: the REPL's per-event loop is woven with UI rendering (toolSlot, diff inline, indicator, footer) — not pure plumbing. Pulling all of that into AgentRunner would either drag UI concerns into the runtime layer or leave most of the REPL intact while AgentRunner handled only the trivial plumbing prefix. Either way the win is marginal. AgentRunner exists for sub-agents (its real consumer) and future surfaces (background review, scheduled missions) — those don't have UI concerns. The REPL keeps its inline call.

2. **v0 path lock is a single in-memory `Semaphore(1)` — not per-path, not on-disk.** The build plan describes a "profile-scoped path lock" for write-capable children. The first iteration of the spec wanted per-path locking with explicit ownership declarations on agent definitions; that's a lot of complexity for a guarantee no real consumer needs yet. v0 ships a single global write mutex: read-only children skip it; write-capable children serialize through it. Cross-process coordination is a Phase 16 (daemon) concern — the harness today is one process per profile. Per-path locking can land later when there's a concrete need (e.g. two write-capable children that legitimately don't conflict).

3. **`allowedTools` filtering is name-only in v0 — pattern constraints (e.g. `Bash(git log *)`) are not enforced at the scheduler.** The bundle-shipped `explore` agent declares `allowedTools: [Read, Grep, Glob, Bash(git log *), ...]`. We extract the bare tool name from each entry (`Bash`, not `Bash(git log *)`) and filter the parent pool by it. The pattern constraint inside the parens is left to the parent's `canUseTool` — which still applies in the child context. The exclusion set covers the dangerous defaults (no recursive AgentTool, no parent-side control plane), and `readOnly: true` controls the write-lock acquisition. The v0 gap is that a `Bash(git log *)` agent can theoretically run arbitrary Bash commands as long as the parent's permission rules don't block them. Tightening this is a follow-up: layer agent-defined rules into the canUseTool stack as a synthetic rule layer above project rules. Documented in `src/runtime/scheduler.ts` file header.

4. **`patchSchemasAgainstAvailable()` drops AgentTool from the pool when no agents are loaded — does not just leave the open `string` schema.** The simpler design would be to keep AgentTool in the pool with `subagent_type: z.string()` whenever the registry is empty. But that exposes a tool whose every invocation will fail with "unknown subagent_type" — wastes a model turn and produces a confusing error. Closed-enum patching is the only state where AgentTool is invocable at all; if there are no agents, AgentTool is invisible to the model. This is the same pattern Phase 12 will adopt for `ToolSearchTool.tool_names` once that gets formalized.

5. **Capability profile is hand-curated for v0; provenance field is the upgrade path.** The build plan hints "eval data accumulated through the Phase 10.5 part 2 suite seeds the table." We don't yet have enough eval coverage to populate per-model behavioral hints reliably — the entries in `src/router/capabilities.ts` are conservative reads of public spec sheets. Each entry carries a `source: 'curated' | 'eval'` field so Phase 13.4 (continuous-learning observation stream) can graduate refined entries without breaking the table's shape. Cross-consistency test asserts that contextLength values agree with `src/providers/models.ts::contextLengthFor()` — the two tables can't drift on the field they both carry. Two consumers today: router classifier (already wired through Phase 10.6) and the sub-agent scheduler's `role:` resolver.

## 2026-05-05 - Phase 10.5 part 2b-i — replay stubs the provider + tool boundaries, nothing else

The replay primitives (`ReplayProvider`, `wrapToolsForReplay`) drive the existing agent loop with canned events. The choice of *where* to stub is the load-bearing decision:

1. **Stub at the provider boundary** — `ReplayProvider` implements `LLMProvider` and delegates nothing to a real upstream. Inside `query()`, the agent loop sees identical StreamEvents as a live run; permissions / hooks / orchestrator partitioning all fire normally because they consume the assistant message, not the bytes that produced it.
2. **Stub at the tool boundary** — `wrapToolsForReplay` swaps `tool.call()` for a fixture lookup. The orchestrator's permission gates, schema validation, partitioning, and hook plumbing all run on the wrapped tool exactly as they would on the real tool. Only the work inside `call()` is canned.

What we explicitly *don't* stub: the orchestrator, the turn loop, message schema, permissions, hooks, microcompaction, loop detector, trajectory writer, trace writer, or the REPL. They all run live. This means a replay can catch real regressions in any of those layers — if the orchestrator silently drops a tool result on rerun, the captured fixture from the prior good run replays differently and the test fails.

Other decisions worth recording:

- **Tool-result correlation by `(toolName, callIndex)`, not `(turnIndex, toolUseId)`.** The orchestrator doesn't expose tool_use_id to `tool.call()`; threading it through would be a bigger change. The simpler scheme works because replay drives the turns deterministically: if the agent makes the same calls in the same order, indexes line up. If the agent diverges (different tools, different counts), the wrapper throws — which is the desired loud failure for a replay drift.
- **Fixture as one JSON object per session, not JSONL per turn.** Easier to read in a text editor and small enough today (a typical 10-turn session is well under 100 KB). If sessions get massive, split format becomes the natural follow-up.
- **No semantic test in this slice.** Replay is internal test infrastructure, not an agent-prompt-driven surface — same posture as the eval-suite runner (2a) itself. The integration test (`tests/eval/replay/integration.test.ts`) is the round-trip evidence that replay primitives wire cleanly into `query()`.
- **Capture mode deferred.** Today you can hand-write a fixture (the unit tests do this) or have a future capture wrapper produce one. Splitting capture into 2b-ii keeps this commit small + reviewable; the primitives ship + are testable on their own.

## 2026-05-05 - Phase 10.5 part 2a — `evals/goldens/` parallel to `tests/semantic/`, not folded in

The build plan §10.5 calls for an `evals/golden/` directory. The repo already has `tests/semantic/` doing semantically similar work (live-LLM, sandboxed, end-to-end). Why two parallel suites instead of folding evals into the semantic infrastructure?

1. **Different judges, different costs.** Semantic tests use an LLM judge that scores fuzzy criteria (~$0.05/test for the agent + judge round-trip). Goldens use deterministic code assertions (no judge LLM at all — just file-state and transcript regex checks). Mixing them in one runner conflates the cost models and the failure-mode interpretation.
2. **Different invariants.** Semantic tests are about *meaning*: "did the agent understand the request?". Goldens are about *behavior*: "did the file end up with the right content?". Both matter; both should be added when shipping new surface area; the invariant being tested differs.
3. **Different review cadence.** Semantic tests iterate on the judge prompt + the case prompt + the criteria; goldens iterate on the assertion list + the seed files. The two suites move at different speeds.

Trade-off accepted: `tests/semantic/framework/` (sandbox, driver, ANSI strip) and `src/eval/runner.ts` duplicate ~100 lines of subprocess-spawn code. If the duplication grows, extract a shared `src/util/agentRunner.ts` in a follow-up. Today the duplication is small enough that it doesn't justify the indirection.

A few smaller decisions inside this slice worth recording:

- **Assertions are pure.** No tool execution inside the assertion evaluator (no "run X to verify Y"). The runner already executed the agent; assertions just observe the resulting state. Lets the assertion module stay test-friendly.
- **Tool-call totals come from parsing the session-summary footer**, not from a structured event. The footer is what users see and what the trajectory capture also keys off of, so the same source of truth feeds the eval. If the footer format ever changes, both surfaces have to update — but that's already true.
- **Budget JSON is opt-in, not auto-injected.** A missing `evals/budget.json` is a no-op (no checks). The runner only fails on budget when the file is present. Reason: not every project wants to track regressions on a budget; making it implicit would punish small repos.
- **Live-LLM goldens are not part of `bun test`.** Same posture as the semantic suite: opt-in via `sov eval run`, never auto-runs. This keeps the unit suite cheap + offline. CI can run goldens explicitly when desired.
- **Replay (deterministic CI mode) is intentionally deferred to part 2b.** The capture-then-replay path needs care to round-trip every StreamEvent + tool result faithfully. Shipping live goldens first gets the MVP into hands; replay adds the CI muscle on top.

## 2026-05-04 - Phase 10.6 part 1 — router as a meta-LLMProvider, deterministic classifier, audited

The local-model router lives at the LLMProvider layer: `RouterProvider` implements the same `name + stream` interface as Anthropic / OpenAI / Ollama / OpenRouter, then per-call delegates to one of two child LLMProviders (a "local" lane and a "frontier" lane). Several decisions worth recording:

1. **Router is itself a Provider, not a side-panel decision engine.** The query loop, orchestrator, hooks, MCP, permission gates, and existing provider hardening all see "one provider with a name=`router`" — they need no router-aware code paths. The classification + audit logic stays inside the RouterProvider's `stream()`. Reason: keep the turn-loop boundary simple. Anything that can be solved at the provider layer should be.

2. **Deterministic, rule-based classifier — no keyword "vibes" matching.** Inputs are user override + frontier triggers (recent tool errors ≥ 3, schema failures ≥ 2, context overflow heuristic). Build plan §10.6 calls out "learned routing policy" as an explicit skip — the goal here is that the user can predict what the router will do. Adding fuzzy text matching would erode that.

3. **`escalationMode: 'ask'` currently degrades to the default-lane fallback (no actual prompt).** The interactive prompt UX is deferred to a follow-up; today `'ask'` and `'never'` both stay on `defaultLane`. Reason: shipping the prompt-flow alongside the router doubled the surface area and pushed the commit out. The mode value is stable; just the user-interaction path lands later.

4. **Raw prompts are NEVER recorded by default.** The audit log stores a SHA-256 of the prompt, never the prompt itself. Build-plan §10.6 keeps raw-prompt logging opt-in; that opt-in flag is deferred (probably a per-profile setting). Trade-off: less debugging signal in the audit file vs. zero risk of silent data-leak from a misconfigured logger.

5. **Audit logger reuses TraceWriter's posture.** Append-only JSONL with a sequential write chain, redaction via the trajectory allowlist, best-effort no-throw on filesystem errors (Invariant #10). The pattern is now repeated three times (TraceWriter, RouterAuditLogger, TrajectoryWriter); a future refactor could consolidate, but the duplication is small and each module has subtly different schemas.

6. **`localContextLength` is the only capability hint plumbed today.** The classifier's context-overflow rule needs the local provider's context cap to know when prompts can't fit. Per-model TTFT, JSON-mode reliability, and other capability metadata stay in the build plan but are deferred to Phase 10.6 part 2 — they need eval data to populate (Phase 10.5 part 2's golden tasks would feed them).

7. **`getNextOverride` callback for per-call user override.** A function getter (rather than a field) keeps the override consumed-once semantic clean: the REPL's `/escalate` slash (TODO) writes to a closure, the router reads + clears via the next stream() call. No hidden state on the provider object.

## 2026-05-04 - Phase 10.5 part 1 — trace events + loop detector

The trace layer is intentionally separate from the trajectory layer (Phase 13.1) even though both write JSONL. Trajectories are training-shaped session captures; traces are operational/audit logs for evals + `sov trace show`. Some choices worth recording:

1. **One trace file per REPL invocation, not per session.** When `/compact` and `/rollback` swap `activeSessionId`, the trace writer keeps writing to the file keyed on the *initial* session id. Rationale: a single REPL run is the natural unit for "what happened operationally," and splitting by post-pivot session ids would scatter related events across files. We record `compaction_start` / `compaction_end` events with both parent and child session ids so a viewer can still reconstruct the lineage.

2. **Trace recorder is a function, not a class.** `traceRecorder?: (event: TraceEvent) => void` on `QueryParams` lets tests inject an array push without constructing a real writer. The REPL wraps `TraceWriter.record` into the function shape. Function abstraction also lets future consumers (e.g., a metrics aggregator) hook the same pipe without touching the writer's class.

3. **Recorder failures never block the session.** Per Invariant #10. `query()` wraps the user-supplied recorder in a try/catch shim so a misbehaving handler can't turn a working session into an error. The TraceWriter itself routes append failures to a log sink (defaults to swallowing).

4. **Trace events go through the trajectory redactor.** The same `redact()` allowlist used for trajectories runs over every line before append. Prevents tool-error messages or input snapshots from leaking secrets into the trace file.

5. **Loop detector clears its history per detector after firing.** The naive design — keep all hashes forever — re-fires the same detection on every subsequent no-op turn (the "stuck" run is still in state). Clearing the firing detector's array means a fresh run of repetitions is required to fire it again. Other detectors keep their state because they detect different signals; clearing all of them on any detection felt like over-resetting.

6. **First detection injects guidance; second terminates.** Direct from the build plan. The orchestrator counts detections per `query()` invocation. The injected user message is a generic prompt to change approach (not detector-specific) — keeping the message constant means the detector logic stays separable from the guidance text.

7. **`sov trace show <session-id>`, not `--session-id <id>`.** Positional arg matches the `git show`/`git log` ergonomics for a sessions-as-objects mental model. The subcommand cluster is open for a future `trace list`, `trace tail`, etc. without breaking the existing surface.

## 2026-05-04 - Phase 10.7 profile system: env-var-before-imports, with `default` reserved

The profile system scopes `<harness-home>` to `<base>/profiles/<name>/` so the same machine can host disjoint setups (work / personal / lab) without aliasing config, credentials, sessions, rate-limit ledgers, memory, or skills. Several design choices worth recording:

1. **Profile selection is `process.env.HARNESS_HOME`, set BEFORE any module that captures the path at load time.** Per Invariant #11. The pre-import argv scan in `src/main.ts` translates `-p <name>` into `process.env.HARNESS_HOME = join(<base>, 'profiles', <name>)` before the static-import tree resolves. This means modules never need to plumb a "profile" argument; they just call `getHarnessHome()` and land under the right root.

2. **`-p` short flag is reassigned from `--provider` (chat) to `--profile` (top-level).** The top-level concept (which state root to use) takes precedence over the chat-subcommand-specific concept (which provider to target). No tests or docs used the old short form, so the breakage is theoretical. Long-form `--provider` is unchanged.

3. **The `'default'` profile name is reserved.** It maps to `<base>/` itself — the unscoped state root, which is also the pre-Phase-10.7 default. Reserving the name lets `sov profile use default` semantically mean "pin back to the unscoped root" without introducing a separate "no profile" concept. `assertProfileName('default')` deliberately throws so the reservation is enforced at every entry point.

4. **`<base>/active-profile` persists the pinned selection.** A plain text file with the profile name (or empty for default). Read on startup when `-p` is absent. Chosen over a flag in `config.json` because a profile selection can't live inside the per-profile config file (chicken-and-egg: which config do we read first?).

5. **The atomic-mkdir PID lock (`<profile>/.sov.lock/`) is shipped as a helper but NOT integrated into REPL startup.** The lock would prevent concurrent `sov` sessions on the same profile, but that's a behavioral change with no clear forcing function — SQLite's WAL mode and the atomic temp+rename pattern for credentials.json already cover the dominant write-collision cases. The helper exists for a future "guard mode" or advisory banner; turning it into a hard guard is a separate decision.

6. **Profile-aware paths use functions, not module-load-time constants.** The first iteration kept eagerly-evaluated `DEFAULT_DB_PATH = join(homedir(), '.harness', 'sessions.db')`-style consts. Those locked in the wrong path when `-p` set HARNESS_HOME after the module was imported. Now every call site uses `getDefaultDbPath()` / `getDefaultCredentialStatePath()` / `defaultRateRoot()` and re-resolves at call time. The deprecated consts remain as back-compat shims (with `@deprecated` JSDoc) so external callers don't break, but in-tree code uses the function form.

7. **`profile import-default` copies `config.json` + `credentials.json` only.** Sessions/trajectories/memory stay clean — a profile is meant to scope history per project, not duplicate it. Refuses to overwrite existing files in the target so re-running it is safe.

## 2026-05-04 - `sov upgrade` Bun-cache workaround: pre-uninstall + optional --purge-cache

`bun install -g <git-url>` doesn't reliably re-resolve against the remote. Two layers of cache fight us:

1. **Lockfile pin** at `~/.bun/install/global/bun.lock`. Bun records the resolved SHA per URL and re-uses it. Symptom: `bun install -g <url>` reinstalls the pinned commit. Workaround: `bun uninstall -g @yevgetman/sov` evicts the lockfile entry. (Without this, requesting a different ref also triggers `DependencyLoop` because the existing install and the new request have the same package name.)

2. **Binary `.npm` manifest cache** at `~/.bun/install/cache/*.npm`. Even after the lockfile is clean, Bun stores a `URL → SHA` mapping in opaque per-package binary files. `bun install --no-cache --force <url>#master` still serves the cached SHA. Symptom verified empirically while verifying Phase 13.1: `sov upgrade` (post-pre-uninstall fix) kept installing `0eee03c` while `git ls-remote` showed master at `797222d`.

Two-step fix:

- **Pre-uninstall is always-on.** `runUpgrade` spawns `bun uninstall -g @yevgetman/sov` before `bun install -g <url>`. Uninstall failures are silently ignored (first-install case). API contract bumped: `UpgradeResult.command: string[]` → `UpgradeResult.commands: string[][]`. `--skip-uninstall` flag for the rare "I want the cached SHA" case.

- **`--purge-cache` is opt-in.** When present, `runUpgrade` `rm -rf`'s `~/.bun/install/cache/` before install. The cache wipe takes out other Bun-installed packages' manifest entries too — regenerable on next install, low cost. `cacheDir` opt is a test seam so unit tests exercise dry-run without touching the real cache.

Rejected alternatives:

- **Always purge the cache.** Defaulting to a destructive cache wipe punishes users who have other globally-installed Bun packages. Make it explicit.
- **Append a unique URL fragment per upgrade** (`#?t=<timestamp>`). Git rejects query parameters in refs, breaks the URL.
- **Clone-and-link instead of `bun install -g`.** Bypasses Bun's caches entirely but loses the upgrade-via-package-manager UX. Worth revisiting if Bun's caching changes shape again.

This is a Bun-side bug surface. If `bun install` ever gains a real "force re-resolve" semantic for git URLs, drop `--purge-cache` and the lockfile-eviction step.

## 2026-05-04 - Distribution: git+ssh, not npm

The harness package and the repo it lives in are private. Distribution uses `bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-harness.git` directly against the private repo; SSH access is the access-control gate (same as cloning). `package.json` is marked `"private": true` so `npm publish` is impossible by mistake.

Rejected alternatives:

- **npm Pro / Teams ($7/mo).** Pays for hidden registry packages. Unnecessary when SSH-gated git installs achieve the same access control free.
- **Public npm publish.** The harness binary is harmless to leak (it requires an Anthropic key to do anything; source posture stays "all rights reserved" via the `license` field), but the user explicitly asked for non-public access. Falling back to git+ssh respects that.
- **GitHub Packages.** Adds `.npmrc` PAT-auth setup per machine. More friction than git+ssh for single-user / small-team distribution. Worth revisiting if a team distribution emerges.

`sov upgrade` shells out to `bun install -g git+ssh://...` so users don't have to remember the URL. `--ref <ref>` pins to a tag, branch, or commit; `--dry-run` prints the command; `SOV_UPGRADE_URL` env var overrides for forks. The pure argv-builder is split from the spawning runner so unit tests don't actually re-install bin during test runs.

## 2026-05-04 - Phase 12.6 Context Budget: Six Design Decisions

`auditContextBudget()` (`src/context/budget.ts`) walks the live context inventory and reports per-component token estimates with bloat tier and triage classification. Choices:

1. **Token estimation is the existing 4-chars-per-token heuristic from `src/core/tokenEstimate.ts`.** Provider-exact tokenization (CL100K, tiktoken, etc.) would require shipping per-provider tokenizer libs and is overkill for triage. The estimator is good enough to identify "this skill is heavy" without claiming exact token counts.

2. **Bloat tiers (`heavy` / `extreme` / null) and per-kind thresholds.** Defaults from ECC's experience: skill 300/800, tool-schema 500/1500, system-segment 800/2000, memory 1000, bundle 1500/3000. Overridable via the `thresholds` opt and the prospective `~/.harness/config.json` `contextBudget.thresholds.*` block. Two tiers because the action differs — a heavy skill might be acceptable; an extreme one is almost certainly bloat.

3. **Classification (`always` / `sometimes` / `rarely`)** uses skill `requires_tools` / `fallback_for_tools` against the active toolset, not just static analysis. "Recent invocation" as a classification signal is deferred until Phase 13.1 (trajectory) lands; until then classification is visibility-only.

4. **HarnessInfo gains a `'budget'` section.** The model can call HarnessInfo to ask its own context-budget question — useful for meta-questions ("why is this session slow?", "what should I drop?"). Wraps the same `auditContextBudget()` so there's one source of truth.

5. **Slash command surface is `/context-budget` (Info category).** Mirrors the per-section `/tools`, `/skills`, `/permissions` commands. The CommandContext gets a `getBudgetReport()` hook so the command and HarnessInfo share the same builder.

6. **Auto-warning at 60%+ utilization deferred.** Invariant #4 freezes the system prompt per session — a `<runtime-context>` warning would only appear at session start, never mid-session as utilization climbs. The audit currently surfaces utilization on demand via `/context-budget`. A pre-prompt warning footer (similar to the existing pre-compaction warning) is the right shape if usage shows it's needed.

## 2026-05-04 - Phase 12.5 Observation Envelope: Three Design Decisions

`ToolResult<T>` gains an optional `observation: ToolObservation` field shaped as `{status, summary, next_actions?, artifacts?}`. The orchestrator renders it as a plain-text header above each tool's existing `renderResult` content. Choices:

1. **Optional in v1, not required.** Tools opt in by populating the field; tools that don't render exactly as before. Once every native tool has been retrofitted (currently true for all 14 native tools + the MCP wrapper), a follow-up phase can flip the field to required. Keeping it optional means the retrofit lands incrementally without breaking changes.

2. **Plain-text rendering, not JSON.** The envelope shows up in tool_result content as labeled lines (`status: error`, `summary: …`, `next_actions:` + bulleted list). Provider-agnostic — works identically across Anthropic, OpenAI, Ollama. Embedding structured JSON in tool_result content would be more parseable for the model but provider-specific work, and the model already parses labeled-line tool output reliably.

3. **`FileEditTool`'s missing-match and non-unique-match cases flip from throws to envelope-emitting returns.** The throws path bypasses the envelope (the orchestrator's catch wraps the message into a generic is_error tool_result), so the model wouldn't see the recovery hint. Returning a structured `{data: {path, replacements: 0, error}, observation: {status: 'error', next_actions: ['Re-read…']}}` lets the existing `renderResult` show the error message and lets the orchestrator surface `is_error: true` from the envelope. Other FileEdit errors (file doesn't exist, identical strings, empty old_string) still throw — those represent invariant violations or input-shape errors where there's no actionable recovery hint, so the standard catch path is fine.

## 2026-05-04 - Phase 9.6 Skill Trigger Rigor: Heuristic-Only

`validateWhenToUse(value)` runs at skill-load time and emits a one-line warning per low-rigor `whenToUse` entry. Three checks: empty/too-short, low-rigor preamble (`use this skill`, `activate this skill`, `call this when`, …), and absence of any trigger verb from a 22-word allowlist (`asks`, `mentions`, `runs`, `edits`, …).

Decisions:

- **Heuristic, not schema.** No regex DSL or structured predicate AST — `whenToUse` stays a free-form string. The model matches naturally; we only nudge skill authors toward predicate-shaped phrasings via the warning.
- **Warning, not block.** A low-rigor `whenToUse` still loads the skill. The user controls their bundle's quality bar; we surface the nudge but don't gate.
- **Multi-trigger via `;`-separated values.** `SkillsListTool` splits on `;` into a `whenToUse: string[]` array so the model sees discrete predicates instead of one buried sentence. Single-trigger skills keep the original `string` shape — back-compat is the schema, the convention is the splitter.

## 2026-05-04 - HarnessInfo + Self-Doc: Two Complementary Surfaces

Two seams instead of one because they answer different questions. The `<harness-self-doc>` system-prompt segment teaches the *contracts* (settings paths, schemas, slash-command names) — stable, cacheable, vendor-neutral. `HarnessInfo` exposes the *live state* (which settings layers are present, which MCP servers connected, what tools are in the pool) — runtime-evaluated at call time. Either alone is incomplete: the prompt without the tool can't answer "what's connected right now"; the tool without the prompt requires the model to ask "what's the schema for adding an MCP server" without knowing what the answer should look like.

The self-doc segment is deliberately vendor-neutral (`<harness-home>` not `~/.harness/`; no "Sovereign AI" identity) so white-label deployments inherit the same prompt unchanged — product identity comes from the bundle layer.

## 2026-05-04 - WebSearch Hide-When-Disabled + Provider Auto-Detection

`WebSearchTool.isEnabled()` returns false when no Tavily/Brave key is configured. Filtered out at `assembleToolPool` time so the model never sees a tool it can't actually call. The previous behavior surfaced WebSearch regardless and let the call fail with "needs an API key" on every search-shaped prompt — a worse UX than a missing tool because the model picks it up to ten times before giving up.

The error path is preserved as defense-in-depth (test paths, programmatic use, mid-session config drift) but should never fire in normal operation.

Provider auto-detection from key shape: Tavily keys begin with `tvly-` by Tavily's own convention; anything else routes to Brave. An explicit `webSearch.provider` always wins. Solves the user-pasted-Brave-key-into-Tavily-default failure mode without requiring two config commands.

## 2026-05-04 - MCP Server-Prefix Permission Rule

`ruleMatchesTool()` recognizes a server-scoped MCP rule when the tool is MCP and `rule.tool === \`mcp__${tool.mcpInfo.serverName}\``. The match runs off `tool.isMcp` + `tool.mcpInfo.serverName`, not name-string parsing — so server names containing `__` would still resolve correctly. Tool-level rules (`mcp__server__tool`) still hit the exact-match path.

Phase 12's plan claimed "the rule matcher already does prefix matching" — it didn't. This decision corrects that and pins the contract: `mcp__<server>` is a server-scoped rule that matches every tool from that server.

## 2026-05-04 - Phase 12 MCP Client: Eleven Design Decisions

Phase 12 ships the MCP client + deferred tool loading per `harness-build-plan.md` §"Phase 12" and `claude-code-reverse-engineering.md` §11. Eleven choices were locked during implementation; recording here so a future pass that revisits any of them sees the rationale.

1. **stdio transport only this phase.** HTTP/SSE/WebSocket explicitly skipped. The build plan calls this out: "stdio covers most published servers." Adding more transports is additive — the SDK's `Transport` abstraction means new transports plug into `client.ts` without changing the wrapper or anything downstream.

2. **Use `@modelcontextprotocol/sdk` (the official TS client).** Pinned at `^1.29.0`. The SDK owns JSON-RPC framing, schema discovery, and tool invocation; reinventing any of that would be wasted code and a future bug source.

3. **`mcpServers` lives in `RuntimeSettingsSchema` (`src/config/settings.ts`)**, alongside `permissions` and `hooks`. Same layered local→project→user precedence. Servers are concatenated by alias across layers; duplicate aliases throw with both source paths so the user can pick one. Putting MCP in `SettingsSchema` (provider config) instead would make project-level MCP impossible.

4. **All MCP tools default to `shouldDefer: true`.** Otherwise a single MCP server can blow out the prompt — many servers expose 10-30 tools. Native tools stay non-deferred; their schemas are small and stable enough to ship every turn.

5. **Auto-deferral threshold (the build plan's "10% of context" line) is skipped.** Token-count heuristics for "should this tool defer" are easy to get wrong. Deferral is a per-tool boolean; native tools opt in explicitly if needed. The MCP-default behavior already covers the common prompt-bloat case.

6. **Lazy-loading factory pattern (Qwen §3.1) is deferred.** ~14 native + N MCP tools is small enough that eager registration costs little. The wrapper is a thin closure (no expensive imports). Revisit when MCP tool counts cross ~50, or when startup latency from MCP discovery becomes user-visible.

7. **First-use TTY consent for MCP servers is deferred.** The settings.json edit IS the consent — registering an MCP server requires the user to type a command + args, which is a deliberate scoped action. Hooks needed first-use TTY consent because they could be silently invoked by any tool call; MCP servers are explicit external resources. If a real-world abuse pattern surfaces, add consent in a follow-up.

8. **MCP tools use existing `mcp__<server>__<tool>` rule patterns — no new permission code.** The rule matcher's prefix matching already supports `mcp__github` (deny whole server) and `mcp__github__create_issue` (specific tool). Re-using the canUseTool path means the same hooks, prompts, and bypass-mode semantics apply uniformly.

9. **Add `inputJSONSchema?: object` to `ToolDef`/`Tool` for MCP.** When present, the schema serializer uses it verbatim and the orchestrator skips Zod validation on the input (the MCP server validates inputs itself). For native tools, Zod stays the single source of truth. This keeps native tools strict while letting external schemas flow through unchanged.

10. **MCP server lifecycle is session-scoped.** Connect at session start (after settings load), disconnect on session end via `mcpPool.shutdown()`. Connection failures log and skip — one bad server doesn't take down the whole session, the affected tools just don't appear. Restart the harness to retry connections.

11. **`ToolSearchTool` is a native tool, always non-deferred, with a closure over the live deferred-tool list.** It must be in every tools array so the model can find it. Its closure reads from the assembled pool at call time, so newly-discovered tools become searchable without a rebuild. Input is `query: string` (keyword OR `select:n1,n2`); output is the full schemas of matched deferred tools, formatted so the model can read the result and emit a correct subsequent tool_use.

Skipped this phase per the build plan's explicit list: HTTP/SSE/WebSocket transports, MCP resources, MCP OAuth, harness-as-MCP-server (Phase 19).

## 2026-05-04 - Phase 11 Hook System: Eight Design Decisions

Phase 11 ships shell hooks per `harness-build-plan.md` §"Phase 11" and `claude-code-reverse-engineering.md` §10. Eight choices were locked during implementation; recording here so a future pass that revisits any of them sees the rationale.

1. **PreToolUse fires after `canUseTool`, before `tool.call()`.** Permissions deny first — no wasted subprocess spawn for known-bad calls. Hooks observe an already-authorised invocation and can still upgrade to deny or rewrite the input. The orchestrator's flow is: schema-validate → canUseTool → PreToolUse hook → tool.call → PostToolUse hook → render result. Reversing canUseTool ↔ PreToolUse would let a deny-rule-blocked invocation still spend a hook subprocess; not worth it.

2. **`permissionDecision: 'ask'` from PreToolUse is treated as deny with reason.** Wiring the hook back through the same `AskUser` callback would couple the orchestrator to the permission UI for one rare path. Until a real-world hook returns 'ask', the deny-with-reason is the lowest-risk default. Trivial to upgrade later — the hook output is already parsed; only the response handler in `executeOne()` needs a branch.

3. **Overlap-lock util (`src/util/overlapLock.ts` per Fry §A3) is deferred.** No real-world hook hits concurrent reentrancy in the current flows. Add when a smoke test surfaces a problem; the Fry pattern (`os.Mkdir` is atomic; EEXIST → skip) is portable and zero-dep.

4. **Hooks live in `RuntimeSettingsSchema` (`src/config/settings.ts`)**, not `SettingsSchema` (`src/config/schema.ts`). Hooks are runtime policy, layered local → project → user, same lifecycle as permission rules. `loadHookSettings()` parallels `loadPermissionSettings()` and walks the same `getPermissionSettingsPaths()`. `SettingsSchema` (the user-level provider config in `~/.harness/config.json`) is a different concern.

5. **Allowlist keyed by literal command string + event name.** Moving a hook from PreToolUse to PostToolUse re-prompts (cheap defence-in-depth — a hook approved as one event surface should not silently start running on another). Hashing the command body would protect against script substitution but adds complexity; trusting the literal command string mirrors how the rest of settings.json is trusted.

6. **`argvSplit()` is a small purpose-built util, not an npm dep.** ~40 LOC handling whitespace, single/double quotes, `\` escapes, and leading `~/` expansion. No piping, redirection, variable substitution, or globbing — those are shell features that belong inside the user's hook script. Adding `shell-quote` for these few semantics would weigh more than the implementation.

7. **`PostToolUseFailure` (a separate event in Claude Code) is folded into `PostToolUse` with `is_error: boolean`.** The build plan's type signature combined them deliberately — splitting later is a non-breaking change if the matcher schema stays forward-compatible.

8. **Stop hook fires unconditionally on every Terminal — including `error`.** Claude Code skips Stop hooks on API errors to avoid an infinite loop where a Stop hook requests continuation. We don't expose a continuation channel from Stop hooks (they're observers only), so the guard isn't needed. Stop hooks are also fire-and-forget; failures are swallowed.

Skipped this phase by build-plan instruction: `Notification` and `SubagentStop` events; glob matchers like `mcp__*` (waits for Phase 12 MCP); transcript_path / permission_mode in the stdin payload (the build plan's payload spec didn't include them).

## 2026-05-03 - Vim Mode Deferred Indefinitely

The Wave-5 vim-mode plan (~500 LOC: NORMAL/INSERT/VISUAL state machine over the Wave-4 TextBuffer) is deferred. ~70-80% of users don't use Vim, and the LOC-to-felt-value ratio is worse than even Phase-11 hooks. The Wave-4 input editor's TextBuffer already supports every operation a vim layer would need, so adding vim later is a small additive change rather than a refactor.

Reasoning: the polish wave was at diminishing returns. The next 500 LOC spent on capability (hooks, MCP, trajectory capture) beats the next 500 LOC spent on more polish. Vim mode comes back to the table only if a real user asks for it.

## 2026-05-03 - Wave-4 Input Editor With `--legacy-input` Safety Hatch

The Wave-4 raw-mode input editor replaces readline as the default when `process.stdin.isTTY === true`. Bugs that only surface in real terminals (cursor positioning under reflow, modifier-key reporting on uncommon terminals, paste-burst edge cases) won't be caught by unit tests. The `--legacy-input` flag forces the legacy `readline` + `queuedQuestion` path so users can fall back without losing functionality.

Piped stdin always uses the legacy path automatically — the new editor's terminal assumptions don't fit non-TTY input, and CI / scripted sessions need the proven readline behavior.

`queuedQuestion.ts` stays in the codebase indefinitely. Removing it would require replacing the legacy fallback with something else; the cost-to-benefit ratio doesn't favor that.

## 2026-05-03 - Theme Tokens Instead Of Direct `chalk.<color>(...)`

Wave-3 introduced a semantic token registry (`src/ui/theme.ts`) that replaces literal `chalk.<color>(...)` calls in high-traffic renderers. Renderers ask for roles (`accent`, `statusError`, `diffAdded`) instead of concrete colors. Three built-in themes (`dark` / `light` / `no-color`) swap the role-to-color mapping; custom themes from `~/.harness/themes/*.json` are deferred but the registry is structured to absorb them.

Reasoning: theme support was already a felt need (light-terminal users get bad contrast under cyan-on-default; CI / transcript users want stripped output). The token system also makes future contrast / accessibility tweaks (high-contrast theme, colorblind-friendly palette) a config change rather than a code-wide sweep.

The migration is invisible under the dark theme — every existing test passes without assertion changes. Lower-traffic renderers (markdownStream, sessionSummary, info, registry) keep direct chalk calls; sweeping them is mechanical but low-value until a theme actually needs to override their styling.

## 2026-05-03 - Modal Frame For Permission Prompts (Wave 1)

Permission prompts are rendered as a yellow-bordered box (`withModal()` in `src/ui/modal.ts`) instead of an inline `[permission] ...` text line. The framed shape can't be visually buried by concurrent decorator output: the modal raises a module-level `modalActive` flag that decorators (`thinking`, `toolSlot`) consult before writing.

The actual answer is still read through the readline `question()` the REPL owns — we don't open a second readline. The modal is a richer-looking prompt, not a parallel input system.

Reasoning: the prior inline format (`[permission] Bash ls src/`) was a known pain point — under streaming text, the spinner's `\r + clear-line` could clobber the prompt mid-read. The framed box plus the modal-active flag fix both sides of that bug.

## 2026-04-28 - Context-Percentage Trigger For Microcompaction

Microcompaction uses a context-percentage trigger (tool results > 40% of estimated context) rather than Qwen Code's idle-timeout trigger (clear after N minutes of inactivity). The idle-timeout design assumes a user walks away and returns; our harness is continuously model-operated, so idle time is rare but context bloat is constant. The percentage trigger fires when it matters (tool results are crowding out conversational context) regardless of wall-clock time.

## 2026-04-28 - Virtual Tool Name For Cross-Tool Permission Resolution

Shell AST analysis maps read-only Bash commands to `Read` via a `virtualToolName` method on the Tool interface. The alternative was teaching the rule engine to understand shell commands directly, which would have violated the principle that domain semantics stay delegated to tools (Invariant #6). The `virtualToolName` approach lets any tool declare a mapping without the permission system knowing about specific tool input shapes.

## 2026-04-28 - Qwen Code Patterns As Targeted Deepenings

The Qwen Code analysis identified six patterns worth lifting. Two (microcompaction, shell AST) deepened completed phases and landed as immediate implementation. Four (loop detection, tool lazy loading, subagent exclusion set, memory consolidation) are integrated into upcoming phases in `harness-build-plan@6`. Patterns explicitly skipped: MCP OAuth, modifiable tools, SDKs, aggressive auto-memory. See `sovereign-ai-docs/harness/docs/reference/qwen-code-analysis.md`.

## 2026-04-27 - Follow The Maturity-First Build Order

`sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md@6` is the canonical remaining build order. The runtime repo should treat Phase 10.5 soak/evals/traceability, Phase 10.6 local-router hardening, and Phase 10.7 profiles as the next maturity work before hooks, MCP, sub-agents, task parallelism, and reviewed self-learning. Broad channel/API surfaces are optional reach work, not core private-harness maturity.

Reasoning: the harness is for private use with a local or hybrid LLM, not for launching a competing agent product. The capability gap that matters most is robustness: traceable behavior, profile isolation, reliable local-model routing, recursive sub-agents, bounded parallelism, and Hermes-style propose-then-promote learning.

## 2026-04-26 - Keep Business Context Outside The Runtime Repo

The harness repo documents runtime behavior, extension points, and operational usage. Product strategy, business context, and ADR H-0003 remain in the sibling docs repo.

Reasoning: this repo is intended to be deployable as runtime code against different client bundles. Pulling client-zero business context into `src/` or repo-local runtime docs would make the runtime less portable.

## 2026-04-26 - Treat README As Orientation, Not Phase Ledger

Detailed phase completion notes moved to `CHANGELOG.md`. The README keeps current status, setup, usage, and links to deeper docs.

Reasoning: the phase log was useful but made the README harder to scan for new developers. Keeping the log preserves history while making the first-read path shorter.

## 2026-04-26 - Document Extension Surfaces Before Future Phases

The repo now has `docs/architecture.md` and `docs/extending.md` before Phase 11 starts.

Reasoning: phases 0-10 established the core contracts. Hooks, MCP, sub-agents, review, and routing will be easier to implement consistently if the existing extension surfaces are explicit first.

## 2026-04-26 - Split Operator Usage From README

The repo now has `docs/usage.md` for day-to-day runtime operation. The README keeps quick-start commands and links to the full guide.

Reasoning: install, architecture, development, and operator behavior were competing for space in the README. A dedicated usage guide makes common workflows easier to find without losing detail.

## 2026-05-13 - Phase 16.1 — Split-process architecture (TS server + Go TUI)

Source: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.1

`sov` (TS / Bun) runs the agent and a Hono HTTP+SSE server bound to `127.0.0.1`. `sov-tui` (Go) is a separate child process that connects via SSE. Same backend will later serve IDE plugins and other channel adapters without rework. Architectural choice supersedes the umbrella roadmap's single-process options.

## 2026-05-13 - Phase 16.1 — TUI framework: Go + Bubble Tea (closes Open Q1)

Source: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.2
Closes: Open Q1 from `docs/specs/2026-05-13-production-harness-roadmap-design.md` §6.

The Charm stack (`bubbletea`, `lipgloss`, `bubbles`, `glamour`, `chroma`) is the most mature TUI ecosystem in any language. Ink was scrapped per the 2026-05-12 revert postmortem. OpenTUI / SolidJS rejected: the umbrella roadmap's claim that opencode uses OpenTUI is incorrect; opencode uses Bubble Tea.

## 2026-05-13 - Phase 16.1 — Differentiator: polish craft, not feature expansion

Source: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.3

The TUI wins on Claude Code's surface area at visibly higher quality. Out of scope: session browser, command palette, in-transcript search, multi-pane layouts, image rendering, vim keybindings.

## 2026-05-13 - Phase 16.1 — Layout: anchored bottom chrome

Source: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.4

Fixed bottom input row + fixed bottom status row; transcript viewport fills the space above. Selected over CC-style floating-inline input and editor-style top-status during 2026-05-13 brainstorming. Layout B in the brainstorming companion artifact.

## 2026-05-13 - Phase 16.1 — TUI binary delivery: postinstall `go build`

Source: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.5

`package.json` postinstall runs `bun run scripts/build-tui.ts`, which detects Go 1.22+ on PATH and runs `go build ./packages/tui/cmd/sov-tui` into `bin/sov-tui`. Missing-Go failures print remediation and `sov` falls back to `--ui repl` until fixed.

## 2026-05-13 - Phase 16.1 — terminalRepl coexists through M11 (Postmortem Rule 1)

Source: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.6
References: `docs/postmortems/2026-05-12-phase-16-revert.md` Rule 1

`terminalRepl.ts` and its helpers (`src/commands/**`, `src/ui/**` other than the new TUI subdirectory if any) are not deleted, deprecated, or refactored from M0 through M11 (default flip). Removal happens at M13 at the earliest.

## 2026-05-13 - Phase 16.1 — Transport: HTTP + SSE on 127.0.0.1

Source: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.7

HTTP + Server-Sent Events. Not WebSockets. Bun + Hono server side; standard `net/http` + line-by-line SSE parse on the Go client side. v1 binds to `127.0.0.1` only; no auth.

## 2026-05-13 - Phase 14 (Distribution) dropped from roadmap

Source: user direction during 2026-05-13 brainstorming

Phase 14 (npm publish, Homebrew tap, install.sh, public docs site) is dropped entirely. The harness is proprietary; distribution is deferred until the product is production-grade. `bun install -g git+ssh://...` remains the single supported install path.

## ADR M9-01 — Theme is constructor-injected, never a global

Decision: Every component that needs theme tokens takes `theme.Theme` in its `New(...)` constructor (or as a struct field initialized at construction). There is no package-level `theme.Current` or singleton. Theme switching (`/theme <name>`) updates `app.Model.theme` and dispatches a re-render; each component receives the new theme via `SetTheme(t theme.Theme)` accessors.

Rationale: A package-level global would couple every render path to module-load order and would make `tea.Msg`-driven theme switching require a full re-init of the model tree. Constructor injection makes the swap a pure re-render. Mirrors the pattern from the M7 SessionContext (per-session state passed in, not global).

Status: implemented (M9 — `ba8f389` (T1 — theme package foundation + constructor injection)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-02 — `internal/render/*` is pure: `(text, theme, width) → string`

Decision: All functions under `packages/tui/internal/render/` are pure: they take their inputs (text, theme, width) and return a styled string. No `tea.Msg`, no `tea.Model`, no I/O. Errors fall back to `render.Plain` rather than propagating — the TUI must never crash on garbage input from the model.

Rationale: Pure renderers are testable with table-driven unit tests; impure ones would need the teatest harness for every assertion and would couple to component lifecycle. The fallback-on-error policy matches the M6/M8 pattern of "the model can produce anything; the TUI must remain functional."

Status: implemented (M9 — `6cda7b7` (T2 — render package with glamour + chroma + Plain)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-03 — TOML theme loader deferred to M9.5; built-in light + dark only in M9

Decision: M9 ships exactly two themes: Catppuccin Mocha (dark, default) and Catppuccin Latte (light). The `~/.harness/themes/*.toml` loader specified in `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §6 is deferred to M9.5 — a small mini-phase between M9 and M10 dedicated to TOML schema + loader + precedence.

Rationale: The loader is ~80 LoC but adds a config-resolution surface (precedence: env > config > built-in) that benefits from its own design pass. Better to ship demo-quality with 2 themes than have 3 weeks of TOML schema discussion. Two built-ins already validate the constructor-injection pattern (ADR M9-01) and the theme-swap re-render path.

Status: implemented (M9 — `ba8f389`); loader deferred to M9.5.

## ADR M9-04 — `status_update` live-cost source = server-pushed SSE event

Decision: The TUI's streaming spinner + live cost field are driven by `status_update` SSE events emitted from `src/server/routes/turns.ts` at turn start (`streaming: true`) and just before `turn_complete` (`streaming: false`, plus `tokensIn` / `tokensOut` / `cost`). The cost is computed via `estimateCostUsd` against the resolved provider so it matches what `disposeSessionContext`'s `session_summary` will report.

Rationale: Client-derived cost from `turn_complete.usage` would only update at end of turn — no liveness during streaming. Server-push provides the start-of-stream signal the spinner pivots on. Throttling on the server side is light because `usage_delta` fires once per provider response, not per token — no high-frequency burst to debounce.

Status: implemented (M9 — `cd3cc51` (T10 — status_update emission + statusline streaming spinner)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-05 — Slash autocomplete cache: fetched at boot, slightly stale tolerated

Decision: The slash autocomplete popup (`components/slashautocomplete.go`) fetches its skill list via the M8 T6 hydration once per session (`fetchSkillsCmd` at boot) and caches it. Subsequent skill additions during a long-running session won't show until the next session start; the popup falls through to the static slash-command list (`/compact`, `/expand`, `/theme`) if the cache is empty or 5xx'd.

Rationale: Per-keystroke fetch adds latency to a hot-path keypress; cache-and-tolerate-stale matches the M8 T6 skill-cache pattern and the cost is bounded (the user can always type the slash without completion and the server still dispatches correctly via M8 T5's `kind: 'skill'` route). M9.5 may add invalidation on `compaction_complete` if skill churn becomes a real workflow.

Status: implemented (M9 — `8922b8c` (T8 — slash autocomplete popup)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-06 — Mouse v1 = wheel-scroll only; click handling deferred

Decision: `cmd/sov-tui/main.go` enables `tea.WithMouseCellMotion()` so mouse events reach the model. The app's `Update` forwards `tea.MouseMsg` events to `transcript.Update` — bubbles' viewport handles wheel-scroll natively. Click events (focus, toggle-collapse, hover) are NOT handled in M9; they fall through silently.

Rationale: Click handling requires modal-stack interaction analysis (does a click inside the permission modal pass through to the transcript? does a click outside the slash autocomplete dismiss it?) — that's M9.5 work once the modals' coexistence rules are settled. Wheel-scroll has zero modal interaction and delivers most of the user-perceived "this feels alive" benefit.

Status: implemented (M9 — `0dc6a8c` (T9 — mouse wheel scroll)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-07 — `/expand` ring buffer (M8 T6) stays untouched; diff focus is orthogonal

Decision: M8 T6's `/expand [N]` ring buffer and M9 T5's `DiffView` focus state are SEPARATE state. `/expand` re-renders the Nth-most-recent tool block in the transcript. `DiffView` (focused via `Ctrl+]`, navigated via `j`/`k`) is the cursor that moves through hunks WITHIN an expanded diff. The two never interact: expanding a diff does not auto-focus it; focusing a diff does not modify the ring.

Rationale: Conflating "expanded tool result" with "focused diff view" would make `j`/`k` ambiguous (scroll inside the expanded result? navigate hunks?). Keeping them as orthogonal states preserves vim-like navigation semantics inside a focused diff while the `/expand` ring stays a pure re-render registry.

Status: implemented (M9 — `166ce21` (T5 — DiffView component + focus-target Model field)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-08 — Compaction marker is an inline transcript element, not a status-line indicator

Decision: `compaction_complete` SSE events render through `components/compactioncard.go` as a full-width pill inserted into the transcript at the moment of the compaction. The status line does NOT show "compaction in progress" or "post-compaction" state.

Rationale: Compaction is a discrete in-history moment ("at this point the session hopped from parent to child"), not a continuous state. Status-line space is already crowded (cwd + profile + model + streaming + cost + cache); adding compaction state would crowd it further. An inline pill is also the "right" semantic — it's a marker in the transcript timeline.

Status: implemented (M9 — `279e387` (T7 — components/compactioncard.go + inline render in handleEvent)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-09 — Goodbye card degrades gracefully when M7-shape `session_summary` lands

Decision: `components/goodbye.go`'s `RenderGoodbye` renders the M7 base shape (`totalDispatched` + `byAgent`) ALWAYS, and conditionally appends the M8 T7 extension blocks (tokens + cost, tool counts, durations) only when the respective optional fields are non-nil on the decoded `SessionSummary`. M7-vintage payloads render just the forks block.

Rationale: Forward-compat with older `sov` binaries that pre-date the M8 T7 extension fields. The TS-side schema marked those fields optional; the Go-side renderer matches. Without graceful degradation, an old `sov` server paired with a fresh `sov-tui` would render a half-empty card on legitimate sessions.

Status: implemented (M9 — `279e387` (T7 — RenderGoodbye conditional blocks)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-10 — `src/ui/terminalRepl.ts` untouched (Postmortem Rule 1, again)

Decision: Throughout the M9 12-task implementation, no edits to `src/ui/terminalRepl.ts` or any of its imports. All M9 code lives parallel-additive in `packages/tui/` (Go side) plus minimal additions to `src/server/routes/turns.ts` (one new `status_update` emission site).

Rationale: Postmortem Rule 1 binds through M11 (default flip). M9 is foreground-surface refactor adjacent — it's the milestone where the new TUI becomes visibly polished — but the parity audit (M10) and the default flip (M11) are still ahead. terminalRepl must remain the default + functional through both.

Status: verified (M9 — final regression suite confirms `git diff master -- src/ui/terminalRepl.ts` returns empty). Plan: `docs/plans/2026-05-16-phase-16-1-m9-visual-polish.md`.

## ADR M9-11 — Theme palette = Catppuccin (Mocha dark, Latte light)

Decision: M9 ships Catppuccin Mocha for the dark palette and Catppuccin Latte for the light palette. Both are free-to-use, AA-contrast tested, and well-known to developers. The palette tokens map onto `theme.Theme`'s 13 fields (background, foreground, dim, border, primary, success, warning, error, info, codeBackground, diffAdded, diffRemoved, diffContext).

Rationale: Catppuccin is a deliberately neutral choice — no strong personality, broad community familiarity, no licensing concerns. The 2-theme initial set validates the constructor-injection pattern; a custom Sovereign palette can land in M9.5 alongside the TOML loader.

Status: implemented (M9 — `ba8f389` (T1 — light.go + dark.go palettes)).

## ADR M9-12 — `/theme <name>` is a dedicated slash command, not a delegate to /config

Decision: The TUI registers `/theme <name>` as a first-class slash command in the ENTER handler, parsed inline by `app.go`'s slash interception block (before `/compact`, `/expand`, `/skillname`, etc.). It updates `m.theme` in-memory and propagates via `SetTheme` calls to transcript + autocomplete + statusline. Persistence to `~/.harness/config.json` is deferred; the choice is per-session.

Rationale: A dedicated slash gives the feature discoverability (the slash autocomplete popup lists `/theme` first thing). Falling through to a `/config set theme <name>` semantic would have required a server round-trip (the harness-config write is server-side); per-session in-memory is simpler and matches user mental model ("I'm switching themes for this session"). M9.5's TOML loader will add persistence + cross-session theme memory.

Status: implemented (M9 — `ba8f389` (T1 — /theme slash handler in app.go)).

## ADR M9.5-01 — TOML schema is flat snake_case; built-ins always win by name

Decision: User TOML theme files live at `<harnessHome>/themes/<name>.toml` and use a flat snake_case schema (`background`, `code_background`, `diff_added`, etc.) that maps to the camelCase Go fields via BurntSushi/toml struct tags. When `theme.Resolve(name)` is called, the four built-ins (`dark`, `light`, `tokyo-night`, `sovereign`) ALWAYS win — TOML files cannot override a built-in name. Users who want to customize a built-in must save their TOML under a different name (e.g., `dark-pastel.toml`).

Rationale: Override semantics introduce a precedence-resolution surface that has to be documented + tested + thought about for every name collision. Flat priority ("built-ins win") is trivially explainable and gives users the same fork-and-rename pattern they already use for shell themes / editor color schemes. The TOML schema being flat (not nested by category) matches the pattern Catppuccin / Tokyo Night themes ship with.

Status: implemented (M9.5 — `496a1b6` (T1 — TOML loader)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-5-theme-polish.md`.

## ADR M9.5-02 — Theme persistence is synchronous best-effort

Decision: `/theme <name>` writes the new theme name to `<harnessHome>/config.json`'s `theme` field synchronously, immediately after the in-memory switch. Write failure (read-only filesystem, permission denied, disk full, etc.) logs a dim transcript marker but does NOT roll back the in-memory switch — the user keeps the new theme for the rest of the session even if persistence fails. The boot read is also best-effort: a missing / unreadable / malformed config.json silently defaults to `dark`.

Rationale: Synchronous matches user mental model ("I switched themes; it persists"). Best-effort matches the M6/M8/M9 "the TUI never blocks on filesystem hiccups" policy — persistence is a convenience, not a correctness requirement. Write order (in-memory FIRST, then disk) means a UI-visible switch always happens; the persistence layer is the optional rider.

Status: implemented (M9.5 — `9eee86d` (T3 — boot read + /theme write)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-5-theme-polish.md`.

## ADR M9.5-03 — Partial TOML files use Dark() per-field fallback

Decision: A TOML theme file may omit any color field; missing fields fall back to `Dark()` palette's value for that field. Only the `name` field is mandatory — its absence returns an error. A user can ship a 3-color TOML and get a working theme that's "Dark with three tweaks." Empty file (no `[colors]` section at all) is valid and produces a literal Dark palette with the file's `name`.

Rationale: Forces no one to copy a 13-color baseline just to tweak a primary. Matches the "Dark is the default" precedent set in M9 ADR M9-01 (theme construction). Future-proofs: any new color field added to `Theme` will use Dark's value for legacy themes without an explicit migration. The "name is mandatory" carve-out keeps the loader's contract honest — a theme without a self-declared identity is malformed.

Status: implemented (M9.5 — `496a1b6` (T1 — LoadFromFile + pickColor helper)). Plan: `docs/plans/2026-05-16-phase-16-1-m9-5-theme-polish.md`.
