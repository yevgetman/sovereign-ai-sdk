# Phase 2 — Multi-provider task routing · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 2 of multi-provider task routing per the design at `docs/specs/2026-05-23-multi-provider-task-routing-design.md` — rich observability + lane timeoutMs enforcement + env-var override. Defers conditional-on-soak items (escalation, parent auto-downgrade, trivial-chat fast-path, profile presets) to Phase 2.5.

**Architecture:** The runtime synthesizes four new SSE event types (`delegator_plan`, `delegator_atom_started`, `delegator_atom_complete`, `delegator_complete`) by observing the scheduler's delegation lifecycle. The TUI compact-line renderer, `sov drive` plain-text renderer, and `sov serve` OpenAI side-channel all consume the events from the existing per-session event bus. Atom session rows are tagged with `metadata.kind='routing-atom'` + lane attribution so `/routing-stats` can aggregate per-session or across all sessions.

**Tech Stack:** TypeScript on Bun + Go (TUI rendering). Hono / SSE (existing). Zod schemas. Pure-function aggregation for stats.

---

## Investigation findings (verified against the codebase)

1. **Scheduler delegation lifecycle:** `SubagentScheduler.delegate()` at `src/runtime/scheduler.ts:146-389`. Hooks: atom start at line ~179 (before `runner.run(input.prompt)`), atom complete at the return paths (~363 success, ~263 interrupted). The scheduler has zero coupling to `ServerEventBus` today. Phase 2 adds an optional `DelegateInput.delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void` callback threaded the same way Phase 1's `resolveLane` and the existing `traceRecorder` are.

2. **SSE event bus + parent's stream:** `src/server/eventBus.ts` exports `ServerEventBus.publish(ServerEvent)` (per-session, root-session keyed); SSE consumer route at `src/server/routes/events.ts`. Schema is `src/server/schema.ts` — `ServerEventSchema` is a `z.discriminatedUnion('type', [...])`. Phase 2 extends it with four new variants.

3. **TUI compact-line renderer:** `packages/tui/internal/components/compactline.go:66-163` `FormatCompactToolLine(...)`. Go-side SSE switch at `packages/tui/internal/app/app.go:1356-1480`. Phase 2 adds a new sibling `delegatorline.go` formatter + four new app.go switch cases. Go-side test pattern at `compactline_test.go` and `app_test.go`.

4. **`drive` command renderer:** `src/cli/driveCommand.ts:277-358` `EventRenderer.handle(ev)` switches on `ev.type`. Phase 2 adds four new cases producing plain-text one-liners.

5. **`sov serve` SSE translator:** `src/openai/streaming/sseTranslator.ts:70-126` `translateStream(gen, ctx, write)` consumes from the `query()` generator, NOT the bus. The new delegator events are bus-published only, so Phase 2 adds a parallel bus subscriber in `src/openai/routes/chatCompletions.ts:301` that writes `event: hermes.delegator.progress\ndata: <JSON>\n\n` via the same `stream.write` closure `translateStream` uses.

6. **SessionDb metadata field:** `src/agent/sessionDb.ts:379-408` `createSession` accepts `metadata?: Record<string, unknown>` (JSON-serialized into the `metadata TEXT` column). Cron (`{kind: 'cron', cronJobId}`), openai (`{kind: 'openai-api', clientSessionId}`), and the existing `createChildSession` closure in `src/server/runtime.ts:945-953` (`{agentName, kind: 'subagent'}`) are the precedents. Phase 2 extends the runtime's closure to write `{kind: 'routing-atom', laneName, laneProvider, laneModel, parentDelegatorSessionId}` for atoms and `{kind: 'routing-delegator', parentSessionId}` for the delegator. No schema migration — JSON-flexible.

7. **Stats query surface:** `src/agent/sessionDb.ts` already has `listSessions(limit=20)` (returns `SessionListEntry[]`), `getSession(id)` (returns full Session with parsed metadata). For `/routing-stats` we add `listRoutingAtomsByParent(parentSessionId)` and `listRoutingAtomsAll()` using `json_extract(metadata, '$.kind')` (already proven safe by `cleanupOldCronSessions` at line 358 in Phase 17).

8. **Skipped `atomTimeout.test.ts`:** `tests/router/atomTimeout.test.ts` is a single `test.skip(...)` with explicit documentation of the three pieces of plumbing needed: `DelegateInput.perChildTimeoutMsOverride?: number`, `ToolContext.laneRegistry?: LaneRegistry`, `AgentTool.call` resolves `ctx.laneRegistry?.lookup(agent.role)?.timeoutMs` and passes it. Phase 2 T3 unskips this test.

9. **Slash command pattern:** `src/commands/registry.ts` registers commands; `src/commands/types.ts` defines `CommandContext`. The closest reader-from-SessionDb example is `/cost` → `ctx.getCost()` → `runtime.sessionDb.getSessionCost(sessionId)`. Phase 2 adds `getRoutingStats: (opts?: { all?: boolean }) => RoutingStatsSnapshot` to `CommandContext`, wired in `src/server/commandContext.ts` (TUI/drive surface) and `src/cli/dispatchCommand.ts` (headless surface).

**Design refinement surfaced during investigation:** atom session rows cannot store `atomIndex` at session-create time — the delegator dispatches atoms one at a time without pre-declaring a plan. Phase 2 derives `atomIndex` at READ time from `ORDER BY created_at ASC` in the stats query; the in-row field is skipped. The bus events still carry `atomIndex` as the runtime's synthesized counter increments per `delegation_started` for the active delegator.

---

## File structure

### Files to create

| Path | Purpose |
|---|---|
| `src/router/progressEvents.ts` | `DelegationLifecycleEvent` discriminated union + `synthesizeDelegationEvents({ bus, rootSessionId, agentRegistry })` factory producing the runtime closure that publishes the four new SSE events. |
| `src/router/stats.ts` | `RoutingStatsSnapshot` type + `computeRoutingStats(rows: Session[])` aggregator. Pure aggregation. |
| `src/commands/routingStats.ts` | `/routing-stats` slash command. |
| `tests/router/progressEvents.test.ts` | Wire-shape tests + synthesis closure ordering. |
| `tests/router/synthesisIntegration.test.ts` | End-to-end SSE event flow (extends Phase 1 T14 pattern). |
| `tests/router/stats.test.ts` | Aggregator unit tests. |
| `tests/commands/routingStats.test.ts` | Slash-command tests. |
| `tests/router/laneTimeoutOverride.test.ts` | `perChildTimeoutMsOverride` plumbing tests. |
| `tests/server/runtime.envOverride.test.ts` | `SOV_TASK_ROUTING_ENABLED` behavior. |
| `tests/agent/sessionDb.routingAtomMetadata.test.ts` | SessionDb helper tests. |
| `tests/router/laneAttribution.test.ts` | Per-atom lane metadata tagging tests. |
| `packages/tui/internal/components/delegatorline.go` | Go formatter for the four event types. |
| `packages/tui/internal/components/delegatorline_test.go` | Go formatter tests. |
| `packages/tui/internal/transport/delegator_events.go` | Go decoders. |
| `packages/tui/internal/transport/delegator_events_test.go` | Decoder tests. |
| `docs/state/2026-05-23-phase-2-task-routing.md` | Close-out snapshot. |

### Files to modify

| Path | Change |
|---|---|
| `src/agent/sessionDb.ts` | Add `listRoutingAtomsByParent(parentSessionId)` + `listRoutingAtomsAll()` using `json_extract`. |
| `src/server/runtime.ts` | (a) `resolveTaskRoutingEnabled(envValue, settingsValue)` helper honoring `SOV_TASK_ROUTING_ENABLED='1'`/`'0'`. (b) Build per-turn `delegationLifecycleRecorder` closure in turns route. (c) Extend `createChildSession` to write `metadata.kind='routing-atom'`/`'routing-delegator'` with lane attribution. |
| `src/runtime/scheduler.ts` | (a) `DelegateInput.perChildTimeoutMsOverride?: number`; consult before `opts.perChildTimeoutMs`. (b) `DelegateInput.delegationLifecycleRecorder?`; invoke at start + completion. (c) `createChildSession` callback signature gains `lane: { name, provider, model } | null` and `isDelegator: boolean`. |
| `src/tool/types.ts` | Add `laneRegistry?: LaneRegistry` and `delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void` to `ToolContext`. |
| `src/tools/AgentTool.ts` | Resolve `perChildTimeoutMsOverride` from `ctx.laneRegistry?.lookup(agent.role)?.timeoutMs`. Thread `ctx.delegationLifecycleRecorder` into `delegate()`. |
| `src/server/routes/turns.ts` | Construct per-turn `delegationLifecycleRecorder` bound to `bus + rootSessionId`. Pass via ToolContext. |
| `src/server/sessionContext.ts` | Passthrough for the recorder. |
| `src/server/commandContext.ts` | Build `getRoutingStats` closure (reads sessionDb, calls `computeRoutingStats`). |
| `src/cli/dispatchCommand.ts` | Build `getRoutingStats` for headless surface. |
| `src/commands/types.ts` | Add `getRoutingStats` to `CommandContext`. |
| `src/commands/registry.ts` | Register `/routing-stats`. |
| `src/server/schema.ts` | Add four new event types to `ServerEventSchema` union. |
| `src/openai/routes/chatCompletions.ts` | Bus subscriber emits `event: hermes.delegator.progress` side-channel SSE. |
| `src/openai/streaming/chunks.ts` | `buildDelegatorProgressPayload(event)` helper. |
| `src/cli/driveCommand.ts` | Four new cases in `EventRenderer.handle` switch. |
| `packages/tui/internal/app/app.go` | Four new cases in SSE event switch. |
| `tests/router/atomTimeout.test.ts` | Unskip; fill in test body. |
| `tests/agents/delegator.integration.test.ts` | Augment Phase 1 T13/T14 with SSE event-flow assertions. |
| `docs/usage.md` | Add "Routing observability" subsection. |
| `docs/testing-log.md` | Append Phase 2 entry. |
| `CLAUDE.md` + `AGENTS.md` (byte-identical) | Update state pointer. |
| `package.json` | Version bump `0.4.1 → 0.5.0` (minor — new SSE event types are notable feature surface). |

---

## Task decomposition

12 tasks. Total expected subagent wall-time: ~3-4 hours.

### T1 — Per-atom lane metadata in SessionDb (~10 wall-min · Opus)

**Files:**
- Modify: `src/server/runtime.ts` (the `createChildSession` closure), `src/runtime/scheduler.ts` (extend callback signature).
- Create: `tests/router/laneAttribution.test.ts`.

Test-first: dispatch via scheduler, query the created session, assert `metadata.kind === 'routing-atom' && metadata.laneName === 'cheap-task' && metadata.laneProvider === 'mock' && metadata.laneModel === 'mock-model' && metadata.parentDelegatorSessionId === <parent>`. Second test for delegator role asserts `metadata.kind === 'routing-delegator'`.

Pass: extend scheduler's `createChildSession` callback signature to surface `lane: { name, provider, model } | null` (computed via `opts.resolveLane(agent.role)`) and `isDelegator: boolean` (`agent.role === 'delegator'`). Runtime closure writes the appropriate metadata. Fall back to existing `{agentName, kind: 'subagent'}` for non-router agents.

Commit: `feat(router): tag atom and delegator child sessions with routing metadata`

### T2 — `SOV_TASK_ROUTING_ENABLED` env override (~8 wall-min · Sonnet)

**Files:**
- Modify: `src/server/runtime.ts` (read sites at lines 592 + 774).
- Create: `tests/server/runtime.envOverride.test.ts`.

Test-first: three tests covering `'1'` enables, `'0'` disables, unset falls through to settings.

Pass: extract `resolveTaskRoutingEnabled(envValue, settingsValue): boolean` pure helper. Returns `envValue === '1' ? true : envValue === '0' ? false : (settingsValue ?? false)`. Replace both read sites.

Commit: `feat(router): honor SOV_TASK_ROUTING_ENABLED env override`

### T3 — Lane timeoutMs enforcement (R-D plumbing) (~25 wall-min · Opus)

**Files:**
- Modify: `src/runtime/scheduler.ts`, `src/tool/types.ts`, `src/tools/AgentTool.ts`, `src/server/runtime.ts`, `src/server/sessionContext.ts`, `src/server/routes/turns.ts`.
- Create: `tests/router/laneTimeoutOverride.test.ts`.
- Modify: `tests/router/atomTimeout.test.ts` (unskip + flesh out body).

Test-first: stub `LaneRegistry` with `cheap-task.timeoutMs = 50`; AgentTool dispatch records the override propagated to the scheduler. Unskipped `atomTimeout.test.ts` uses real scheduler + MockProvider slowMode 200ms + lane timeoutMs 50ms; asserts `interrupted` terminal.

Pass: add `DelegateInput.perChildTimeoutMsOverride?: number` (scheduler reads it before falling back to `opts.perChildTimeoutMs`); add `ToolContext.laneRegistry?: LaneRegistry`; AgentTool resolves override from `ctx.laneRegistry?.lookup(agent.role)?.timeoutMs`. Runtime sets `laneRegistry` on the base ToolContext.

Commit: `feat(router): enforce lane timeoutMs via per-child timeout override`

### T4 — Runtime-synthesized delegator SSE events (~40 wall-min · Opus)

**Files:**
- Create: `src/router/progressEvents.ts`, `tests/router/progressEvents.test.ts`, `tests/router/synthesisIntegration.test.ts`.
- Modify: `src/server/schema.ts`, `src/runtime/scheduler.ts`, `src/tool/types.ts`, `src/tools/AgentTool.ts`, `src/server/routes/turns.ts`, `src/server/sessionContext.ts`.

The keystone task. Adds:
- `DelegationLifecycleEvent` internal union: `{kind: 'delegation_started', childSessionId, parentSessionId, agentName, laneName: string | null, promptPreview}` + `{kind: 'delegation_completed', childSessionId, parentSessionId, agentName, laneName, success: boolean, durationMs}`.
- Scheduler invokes `input.delegationLifecycleRecorder?.(event)` at start and at completion paths.
- `synthesizeDelegationEvents({ bus, rootSessionId, agentRegistry })` factory tracks active delegator state. When `agentName === 'delegator'` starts → publish `delegator_plan`. When `agentName === 'delegator'` completes → publish `delegator_complete` with accumulated lane distribution. When a child's parent matches the active delegator's `childSessionId` → it's an atom dispatch, publish `delegator_atom_started`/`_complete`.
- Schema additions to `ServerEventSchema`: `delegator_plan { type, seq, sessionId, scheduledAtomCount?: number }`, `delegator_atom_started { type, seq, sessionId, atomIndex, laneName, promptPreview }`, `delegator_atom_complete { type, seq, sessionId, atomIndex, laneName, success, durationMs }`, `delegator_complete { type, seq, sessionId, totalAtomCount, laneDistribution: Record<string, number> }`.
- Turns route at `src/server/routes/turns.ts` constructs `synthesizeDelegationEvents({...})` early and passes to `buildSessionToolContext`.

Test-first: schema validation tests for each event type; synthesis closure tests driving a recorded sequence and asserting mock bus publishes the right events in order. Integration test extending Phase 1 T14 pattern with MockProvider toolUseScript, subscribing to the bus, asserting the sequence.

Commit: `feat(router): synthesize delegator atom-progress SSE events from scheduler lifecycle`

### T5 — TUI compact-line renderer for delegator events (~25 wall-min · Opus)

**Files:**
- Create: `packages/tui/internal/transport/delegator_events.go`, `packages/tui/internal/transport/delegator_events_test.go`, `packages/tui/internal/components/delegatorline.go`, `packages/tui/internal/components/delegatorline_test.go`.
- Modify: `packages/tui/internal/app/app.go` (extend SSE switch at line ~1356), `packages/tui/internal/app/app_test.go`.

Test-first: Go decoder tests for each event shape; `FormatDelegatorLine` tests for each event type with expected line contents (`Delegating <n> atom(s) ›` for plan; `→ atom <idx> on <lane>: <preview>` for started; `✓ atom <idx> on <lane> (<ms>ms)` for success or `✗ atom <idx> on <lane> failed (<ms>ms)` for failure; `Done. <total> atoms: <lane>=<count>, ...` for complete).

Pass: implement Go decoders + formatter; extend app.go switch with four new cases each calling `m.print(components.FormatDelegatorLine(...))`. **Run `cd packages/tui && go test ./...`** alongside `bun run test` before committing.

Commit: `feat(tui): render delegator atom-progress events in compact line`

### T6 — `drive` command renderer for delegator events (~10 wall-min · Sonnet)

**Files:**
- Modify: `src/cli/driveCommand.ts`.
- Create: `tests/cli/driveCommand.delegator.test.ts`.

Test-first: feed each event type to `EventRenderer.handle` (with spy on stdout.write or inject a write closure); assert plain-text output matches `[delegator_plan] dispatching <n> atom(s)\n`, `[delegator_atom <idx>] starting on <lane>: <preview>\n`, `[delegator_atom <idx>] complete on <lane> (<ms>ms) <ok|failed>\n`, `[delegator_complete] <n> atoms: <distribution>\n`.

Pass: add four cases to the existing switch.

Commit: `feat(drive): render delegator atom-progress events in plain-text mode`

### T7 — `sov serve` SSE translator emits delegator side-channel (~25 wall-min · Opus)

**Files:**
- Modify: `src/openai/routes/chatCompletions.ts`, `src/openai/streaming/chunks.ts`.
- Create: `tests/openai/streaming/delegatorProgress.test.ts`.

Test-first: integration test using MockProvider toolUseScript driving a turn through `sov serve`; capture raw SSE bytes; assert `event: hermes.delegator.progress\ndata: <json>\n\n` appears for each delegator event with the expected payload shapes.

Pass: in the chat completions streaming branch, before calling `translateStream`, subscribe a closure to the per-session bus that writes the side-channel events via the same `stream.write` closure `translateStream` uses. Unsubscribe in `finally`. `buildDelegatorProgressPayload(event)` is a thin JSON helper colocated with `buildProgressPayload`.

Commit: `feat(openai): emit hermes.delegator.progress side-channel SSE events`

### T8 — SessionDb helpers for routing-atom queries (~10 wall-min · Sonnet)

**Files:**
- Modify: `src/agent/sessionDb.ts`.
- Create: `tests/agent/sessionDb.routingAtomMetadata.test.ts`.

Test-first: seed in-memory SessionDb with root + delegator child + 3 routing-atom grandchildren + 1 `subagent` row for noise. Assert `listRoutingAtomsByParent(<root>)` returns the 3 atoms in created-at order; `listRoutingAtomsAll()` returns all routing-atom rows.

Pass: SQL via `json_extract(metadata, '$.kind')`. `listRoutingAtomsByParent` walks: `WHERE json_extract(metadata, '$.parentDelegatorSessionId') IN (SELECT session_id FROM sessions WHERE parent_session_id = ? AND json_extract(metadata, '$.kind') = 'routing-delegator')`.

Commit: `feat(db): query helpers for routing-atom rows by metadata.kind`

### T9 — `/routing-stats` slash command (~25 wall-min · Opus)

**Files:**
- Create: `src/router/stats.ts`, `src/commands/routingStats.ts`, `tests/router/stats.test.ts`, `tests/commands/routingStats.test.ts`.
- Modify: `src/commands/types.ts`, `src/commands/registry.ts`, `src/server/commandContext.ts`, `src/cli/dispatchCommand.ts`.

Test-first: `computeRoutingStats(rows)` aggregator returns `{ scope, totalAtoms, byLane: { 'cheap-task': { count, pctOfTotal, successCount, successRate, avgDurationMs, totalDurationMs }, ... }, overallSuccessRate, overallAvgDurationMs }`. Success heuristic for v0: atom has `msgCount > 0 && totalTokens.output > 0`. Document this; refine in Phase 2.5 once we have a more reliable terminal-reason store. Command test: mock CommandContext, dispatch `/routing-stats` and `/routing-stats --all`, assert rendered output contains per-lane percentages.

Pass: implement aggregator + command; render with `chalk` color (match `/cost` style); register in registry under category `'session'`.

Commit: `feat(commands): /routing-stats slash command for per-session lane distribution`

### T10 — Extended integration test (T13/T14 augmentation) (~15 wall-min · Opus)

**Files:**
- Modify: `tests/agents/delegator.integration.test.ts`.

Test-first: existing T13/T14 tests already pass; augment with bus subscriptions that capture delegator events; assert sequence for trivial-turn (one of each) and compound-turn (multiple started/complete).

Pass: subscribe to `runtime.eventBus`, accumulate emitted events into an array, assert at end of turn. Tests become slightly longer but the existing assertions stay.

Commit: `test(router): assert delegator SSE event flow in end-to-end integration tests`

### T11 — Documentation + state snapshot (~15 wall-min · Sonnet)

**Files:**
- Create: `docs/state/2026-05-23-phase-2-task-routing.md`.
- Modify: `docs/usage.md` (add "Routing observability" subsection), `docs/testing-log.md` (append), `CLAUDE.md` + `AGENTS.md` (byte-identical, update state pointer).

State snapshot mirrors `docs/state/2026-05-23-phase-1-task-routing.md` structure: HEAD, chain since predecessor, suite numbers, ADRs (none — purely additive), Phase status, what shipped, behavioral notes, open follow-ups (Phase 2.5 conditionals + profile presets), postmortem-rule compliance.

Commit: `docs(router): Phase 2 close-out, usage notes, testing-log entry`

### T12 — Release v0.5.0 (~10 wall-min · Sonnet)

**Files:**
- Modify: `package.json`.

Pass: bump `0.4.1 → 0.5.0` (minor — four new SSE event types are a notable feature surface for downstream consumers). Cut via `bun run scripts/release.ts` per `docs/conventions/cutting-releases.md`. Smoke `~/.sov/bin/sov upgrade && sov --version`.

Commit: `release: v0.5.0 — Phase 2 multi-provider task routing observability`

---

## Risks and unknowns

**R1 — Scheduler hook breaking Phase 1 tests.** T4 adds optional callbacks on `DelegateInput`. Phase 1's scheduler tests do NOT pass them and should continue to work unchanged. Mitigation: run `bun test tests/router/schedulerLaneResolve.test.ts tests/runtime/scheduler.test.ts` after every T4 increment. The pattern matches Phase 1 T7's purely-additive `resolveLane` callback.

**R2 — Go TUI test coverage.** Compact-line tests aren't part of the default `bun run test` gate; require `go test ./packages/tui/...`. T5 implementer MUST run both. Document in the T5 commit.

**R3 — `drive` + `sov serve` translation divergence.** Both T6 and T7 consume the same delegator events for different wires. Mitigation: both reference Zod-validated types from `src/server/schema.ts` (no parallel struct definitions). T10's integration test exercises the bus end-to-end.

**R4 — atomIndex timing.** Delegator dispatches atoms one at a time; the runtime can't know total scheduled count in advance. `delegator_plan` emits with `scheduledAtomCount: undefined`. `atomIndex` in routing-atom metadata is skipped — derived at read time in `/routing-stats` via `ORDER BY created_at ASC`. The bus events carry running counter from the synthesis closure.

**R5 — `SOV_TASK_ROUTING_ENABLED='0'` semantics.** Three-way semantics: `'1'` enables, `'0'` disables, anything else (unset, empty, `'true'`, `'false'`) falls through to settings. T2 tests pin this contract.

---

## Execution

Plan complete. T1 lands the vertical-slice foundation (atom lane attribution); T2 + T3 are independent parallelizable; T4 is the keystone for observability (T5/T6/T7 are independent consumers); T8 + T9 build the read path for `/routing-stats`; T10 backstops with end-to-end coverage; T11 + T12 close out.
