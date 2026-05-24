# State of the build — 2026-05-23: Phase 2 multi-provider task routing

**HEAD:** to be filled by the close-out commit.

**Chain since the Phase 1 close-out (`f09c82c`, 2026-05-23 late afternoon — the `fix(bundle): delegator readOnly: true` commit that landed right after the Phase 1 docs close-out):**
Phase 1 close-out → release v0.4.1 (`544afeb`) → Phase 1 testing-log entry (`03ae9d5`) → Phase 2 plan committed (`1f0080a`) → T1 per-atom + per-delegator lane metadata in SessionDb (`44d4ba0`) → T2 `SOV_TASK_ROUTING_ENABLED` env override (`ee89f36`) → T3 lane `timeoutMs` enforcement via per-child timeout override (`ca27ef0`) → T4 runtime-synthesized delegator SSE events (`06f546a`) → T5 TUI compact-line renderer for delegator events (`db79a54`) → T6 `sov drive` renderer for delegator events (`f07d6a8`) → T7 `sov serve` SSE side-channel for `hermes.delegator.progress` (`ad49932`) → T8 SessionDb query helpers for routing-atom rows (`19bdc42`) → T9 `/routing-stats` slash command (`7dff35e`) → T10 end-to-end SSE event-flow assertions in delegator integration tests (`836fa62`) → (this close-out, TBD).

**Suite:** TS — **2306/0/14** (+63 from Phase 1 close-out's 2243). Breakdown of the +63 across Phase 2 T1-T10: T1 (+2 metadata-tagging), T2 (+5 env-resolution), T3 (+5 = 4 plumbing tests + 1 newly-unskipped atomTimeout — the test file count shifted skip 15→14), T4 (+21 = 19 schema/closure unit + 2 synthesis integration), T6 (+5 drive renderer), T7 (+6 = 4 unit on `buildDelegatorProgressPayload` + 2 e2e SSE-body), T8 (+4 SessionDb queries), T9 (+15 = 8 aggregator + 7 command), T10 (+0 — augmented existing tests with +22 expect calls on bus-event sequences but no new test cases). Go — `cd packages/tui && go test ./...` all green; +21 new tests in T5 (7 decoder + 9 formatter + 5 SSE-switch). Lint+typecheck clean.

**ADRs:** none. Phase 2 is purely additive — four new SSE event types in `ServerEventSchema`, two new optional callbacks on `DelegateInput` (`delegationLifecycleRecorder` + `perChildTimeoutMsOverride`), two new optional fields on `ToolContext` (`laneRegistry` + `delegationLifecycleRecorder`), one new pure-function module (`src/router/progressEvents.ts`), one new pure-aggregator module (`src/router/stats.ts`), one new slash command (`/routing-stats`), one new pair of SessionDb query helpers (`listRoutingAtomsByParent` + `listRoutingAtomsAll`), one Go TUI formatter (`delegatorline.go`), one new env-var read (`SOV_TASK_ROUTING_ENABLED`), one side-channel SSE event name on the OpenAI server wire (`hermes.delegator.progress`). No surface removal, no foreground refactor, no architectural pivot. All design decisions captured in the spec at `docs/specs/2026-05-23-multi-provider-task-routing-design.md` and the plan at `docs/plans/2026-05-23-phase-2-task-routing.md`.

**Phase status:** **Phase 2 closed.** Phase 2.5 (conditional-on-soak items — quality-escalation, parent-model auto-downgrade, trivial-chat fast-path, profile presets) pending soak data from the Phase 2 release. Phase 3 (spend management — per-lane budget caps, monthly ceiling, escalation gates) deferred until Phase 2 + Phase 2.5 soak. Phase 16.1 stays closed; Phase 17 stays closed; Phase 18 stays closed; Phase 21 M1 stays closed; Phase 21 M2 stays backlogged (#48). T11 (this docs close-out) follows; T12 (cut v0.5.0 release) is the next task.

## Where we are

Phase 2 wraps full observability around the Phase 1 smart router. The runtime now synthesizes four new SSE event types (`delegator_plan`, `delegator_atom_started`, `delegator_atom_complete`, `delegator_complete`) by observing the scheduler's delegation lifecycle — no delegator-prompt changes required. The events flow through every consumer surface: the TUI renders them as compact lines (`◇ Delegating …` / `→ atom 0 on cheap-task: …` / `✓ atom 0 on cheap-task (1234ms)` / `◆ Done. 3 atoms: cheap-task=2, frontier-task=1`); `sov drive` prints plain-text bracketed lines suitable for piping; `sov serve` emits a parallel `event: hermes.delegator.progress\ndata: <json>\n\n` side-channel SSE on the OpenAI HTTP server wire so harness-aware clients can render atom-level progress. Per-atom + per-delegator child sessions are tagged with `metadata.kind='routing-atom'` / `'routing-delegator'` + full lane attribution in SessionDb, queryable via two new helpers; a new `/routing-stats` slash command aggregates by lane with optional `--all` for cross-session stats. Lane `timeoutMs` enforcement (Phase 1's R-D R-D follow-up) is now wired through `DelegateInput.perChildTimeoutMsOverride` + `ToolContext.laneRegistry` + `AgentTool.call` resolution; the Phase 1 skipped `atomTimeout` test is unskipped and passing. `SOV_TASK_ROUTING_ENABLED='1'`/`'0'` env-var override honors `1`/`0` and falls through to config otherwise. Nothing in this phase deprecates anything; every existing surface continues to work identically with no observed regressions.

The architecture remains purely additive. The scheduler grew two optional callbacks on `DelegateInput`; `ToolContext` grew two optional fields; one new module under `src/router/` (`progressEvents.ts` — the synthesis closure factory) plus a stats aggregator (`stats.ts`); four new wire events in `ServerEventSchema`; the OpenAI route grew a bus-subscriber-and-side-channel writer that runs in parallel with the existing `translateStream`; the TUI grew a compact-line formatter + Go decoders for the four events; `sov drive` grew four new cases in its `EventRenderer.handle` switch; a new `/routing-stats` slash command + two SessionDb helpers; one env-var read site in the runtime boot. No production behavior changes when `taskRouting.enabled: false` (the default) — the bus events are not synthesized, the side-channel is silent, `/routing-stats` returns "no routing atoms recorded".

The user kicked off Phase 2 mid-session with the work plan from `docs/plans/2026-05-23-phase-2-task-routing.md`. Subagent-driven development per T1 → T10; T11 is this docs close-out; T12 will cut the v0.5.0 binary release. Two design refinements surfaced during investigation and were folded into T4: atom session rows can't store `atomIndex` at session-create time because the delegator dispatches atoms one at a time without pre-declaring a plan, so `atomIndex` is derived at READ time in `/routing-stats` via `ORDER BY created_at ASC`; the bus events still carry `atomIndex` from the synthesis closure's running counter. The synthesis closure is constructed per-turn in `src/server/routes/turns.ts` and bound to the initial root sessionId so compaction hops don't break the binding.

## What shipped

### Four new SSE event types in `ServerEventSchema` (`src/server/schema.ts`)

- `delegator_plan { type: 'delegator_plan', seq, sessionId, scheduledAtomCount?: number }` — published when the delegator session starts. `scheduledAtomCount` is `undefined` in v0 (the delegator dispatches atoms one-at-a-time without pre-declaring a plan; this field is reserved for a future synthesis variant that emits a pre-plan).
- `delegator_atom_started { type, seq, sessionId, atomIndex, laneName, promptPreview }` — published when each atom dispatch starts. `atomIndex` is the synthesis closure's running counter (0-indexed within the active delegator's call graph); `laneName` is the cost-lane name (`cheap-task` | `moderate-task` | `frontier-task`); `promptPreview` is the first ~80 chars of the atom prompt.
- `delegator_atom_complete { type, seq, sessionId, atomIndex, laneName, success, durationMs }` — published when each atom completes. `success: true` if the atom returned `terminal === 'completed'`; `false` otherwise.
- `delegator_complete { type, seq, sessionId, totalAtomCount, laneDistribution: Record<string, number> }` — published when the delegator session completes. `totalAtomCount` is the cumulative atom count from the synthesis closure; `laneDistribution` is a map of `lane name → count` accumulated across the delegator's atoms.

### `src/router/progressEvents.ts` — new synthesis closure factory

- `DelegationLifecycleEvent` discriminated union internal to the runtime: `{kind: 'delegation_started', childSessionId, parentSessionId, agentName, laneName: string | null, promptPreview}` + `{kind: 'delegation_completed', childSessionId, parentSessionId, agentName, laneName, success: boolean, durationMs}`.
- `synthesizeDelegationEvents({ bus, rootSessionId, agentRegistry })` factory produces a `(event: DelegationLifecycleEvent) => void` recorder. The closure tracks active delegator state (current delegator's `childSessionId` + atom counter + lane-distribution accumulator). When an `agentName === 'delegator'` start event arrives, it publishes `delegator_plan` and arms the closure; subsequent child-start events whose `parentSessionId` matches the active delegator's `childSessionId` are atom dispatches and publish `delegator_atom_started` (with incremented `atomIndex`); their completion events publish `delegator_atom_complete`; the delegator's completion event publishes `delegator_complete` (with the accumulated `laneDistribution`) and disarms the closure. Non-delegator child dispatches (e.g., the parent calling `explore` directly) are dropped silently.

### Scheduler lifecycle hook (`src/runtime/scheduler.ts`)

- `DelegateInput.delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void` — invoked after `createChildSession` (`delegation_started`) and at every return path (`delegation_completed` — success path returns `success: true`; interrupted/error path returns `success: false`).
- `DelegateInput.perChildTimeoutMsOverride?: number` — consumed BEFORE the existing `opts.perChildTimeoutMs ?? agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS` fallback. Three-step precedence: override → opts → agent-derived default.

### `ToolContext` extension (`src/tool/types.ts`)

- `laneRegistry?: LaneRegistry` — optional reference to the runtime's lane registry. Set by `buildSessionToolContext` to the runtime's `laneRegistry` so `AgentTool.call` can resolve `agent.role → lane.timeoutMs` at dispatch time.
- `delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void` — set per-turn by `src/server/routes/turns.ts` via `synthesizeDelegationEvents(...)`. Threaded into `scheduler.delegate()` via `AgentTool.call`.

### `AgentTool` plumbing (`src/tools/AgentTool.ts`)

- Resolves `perChildTimeoutMsOverride` from `ctx.laneRegistry?.lookup(agent.role)?.timeoutMs`. Spreads it onto the `scheduler.delegate()` call only when defined.
- Threads `ctx.delegationLifecycleRecorder` into `scheduler.delegate()` so each nested delegation reports through the same closure.

### Per-atom + per-delegator metadata in SessionDb (`src/server/runtime.ts` createChildSession closure)

- Extended scheduler's `createChildSession` callback signature with `lane: { name, provider, model } | null` (computed via `opts.resolveLane(agent.role)`) and `isDelegator: boolean` (`agent.role === 'delegator'`).
- Runtime closure branches on the new fields to pick the metadata shape: `{kind: 'routing-delegator', parentSessionId}` for the delegator; `{kind: 'routing-atom', laneName, laneProvider, laneModel, parentDelegatorSessionId}` for cost-lane atoms; legacy `{agentName, kind: 'subagent'}` for non-router children (preserved unchanged).

### `SOV_TASK_ROUTING_ENABLED` env override (`src/server/runtime.ts`)

- New `resolveTaskRoutingEnabled(envValue, settingsValue): boolean` pure helper. Returns `envValue === '1' ? true : envValue === '0' ? false : (settingsValue ?? false)`. Three-way semantics: `'1'` enables, `'0'` disables, anything else (unset, empty, `'true'`, `'false'`) falls through to settings. Replaced both call sites in `buildRuntime` (the smart-router segment injection check + the preflight check).

### TUI `delegatorline.go` + Go decoders + `app.go` SSE switch (`packages/tui/internal/`)

- `transport/delegator_events.go` — Go struct decoders for each of the four event types matching the Zod schemas. Test: `delegator_events_test.go`.
- `components/delegatorline.go` — `FormatDelegatorPlanLine` / `FormatDelegatorAtomStartedLine` / `FormatDelegatorAtomCompleteLine` / `FormatDelegatorCompleteLine`. Glyph vocabulary: `◇` plan, `→` atom start, `✓` atom success, `✗` atom failure, `◆` delegator done. Layout matches the Phase 22 compact-tool-line family (verb-first, dim trailing details). Lane distribution in the summary is sorted by count desc then name asc for deterministic output. Test: `delegatorline_test.go`.
- `app/app.go` — extended the SSE event switch (around line 1356 from the M22 baseline) with four new cases each calling `m.print(components.FormatDelegatorXLine(...))`. Test: `app_test.go` gained five new SSE-switch tests.

### `sov drive` renderer (`src/cli/driveCommand.ts`)

- Four new cases in `EventRenderer.handle`. Output shapes: `[delegator_plan] dispatching <n> atom(s)\n` (count optional), `[delegator_atom <idx>] starting on <lane>: <preview>\n`, `[delegator_atom <idx>] complete on <lane> (<ms>ms) <ok|failed>\n`, `[delegator_complete] <n> atoms: <distribution>\n` (distribution joined by `, ` and sorted by count desc).
- Test: `tests/cli/driveCommand.delegator.test.ts` (5 cases) — feeds each event type through `handle`, asserts the written line shape.

### `sov serve` SSE side-channel (`src/openai/routes/chatCompletions.ts` + `src/openai/streaming/chunks.ts`)

- New `buildDelegatorProgressPayload(event)` thin JSON helper in `src/openai/streaming/chunks.ts`, colocated with `buildProgressPayload`. Verbatim serialization of the four wire-event shapes.
- Streaming branch of `/v1/chat/completions` now subscribes to the per-session bus (via `getOrCreateBus(sessionId).subscribe(...)`) BEFORE driving `translateStream`. Filter: events of types `delegator_plan` | `delegator_atom_started` | `delegator_atom_complete` | `delegator_complete`. Each match writes `event: hermes.delegator.progress\ndata: <JSON>\n\n` via the same `stream.write` closure `translateStream` uses. `unsubscribe()` runs in the route's `finally` block so a closed stream never receives writes from a late publish.
- Tests: `tests/openai/streaming/delegatorProgress.test.ts` (6 cases) — 4 unit tests on `buildDelegatorProgressPayload`, 2 e2e tests pre-seeding the bus with synthetic events and asserting the side-channel frames appear in the SSE body.

### SessionDb query helpers (`src/agent/sessionDb.ts`)

- `listRoutingAtomsByParent(parentSessionId): Session[]` — walks `WHERE json_extract(metadata, '$.parentDelegatorSessionId') IN (SELECT session_id FROM sessions WHERE parent_session_id = ? AND json_extract(metadata, '$.kind') = 'routing-delegator')`. Returns all atom rows under any delegator under the parent, ordered by `created_at ASC`.
- `listRoutingAtomsAll(): Session[]` — `WHERE json_extract(metadata, '$.kind') = 'routing-atom'`. Cross-session aggregation.
- No schema migration — `metadata TEXT` column already in place since Phase 17; queries use the same `json_extract` precedent set by `cleanupOldCronSessions`.

### `/routing-stats` slash command (`src/commands/routingStats.ts` + `src/router/stats.ts`)

- `src/router/stats.ts` — pure aggregator. `computeRoutingStats(rows: Session[]): RoutingStatsSnapshot` returns `{ scope: 'session' | 'all', totalAtoms, byLane: { [laneName]: { count, pctOfTotal, successCount, successRate, avgDurationMs, totalDurationMs } }, overallSuccessRate, overallAvgDurationMs }`. Success heuristic for v0: `outputTokens > 0` (proxy for "atom produced an assistant message"). Documented for refinement in Phase 2.5.
- `src/commands/routingStats.ts` — slash command shell. Args: `[--all]`. Resolves `ctx.getRoutingStats({ all })`, renders with chalk-colored output (header / total / overall success / per-lane breakdown with `name padded — <count> atom(s) (<pct>) — <success-pct> success — <avg-dur> avg`). Lanes sorted by count desc. Returns `'routing-stats is not wired in this surface'` when `ctx.getRoutingStats` is `undefined` (e.g., headless `sov dispatch`).
- `src/commands/types.ts` + `src/server/commandContext.ts` + `src/cli/dispatchCommand.ts` — `getRoutingStats?: (opts?: { all?: boolean }) => RoutingStatsSnapshot` added to `CommandContext`. Server surface wires it via the runtime's sessionDb helpers; dispatch surface leaves it unwired (the command's runtime check returns the friendly "not wired" message).
- Tests: `tests/router/stats.test.ts` (8 aggregator unit tests) + `tests/commands/routingStats.test.ts` (7 command tests). Single-session, multi-lane, --all, no-atoms-recorded, mixed-success-rate, fractional-rounding, sorted-output-stability, missing-lane-name-graceful all covered.

### Tests modified (T10)

- `tests/agents/delegator.integration.test.ts` augmented with bus subscriptions that capture delegator events. Trivial-turn test asserts the exact sequence `delegator_plan → delegator_atom_started → delegator_atom_complete → delegator_complete`. Compound-turn test asserts multiple `delegator_atom_started`/`_complete` pairs across atoms with the correct `atomIndex`/`laneName`/`success`/`durationMs` shapes. `+22 expect calls` added; no new test cases.

## Behavioral notes worth knowing next session

1. **The synthesis closure is per-turn.** Constructed in `src/server/routes/turns.ts` at the top of each `/sessions/:id/turns` request, bound to the initial root sessionId. This means microcompaction hops (which mint a new session) don't break the event binding — the closure keeps publishing to the original root's bus. Phase 4 compaction will need to verify this remains true if the compaction model changes.
2. **Active-delegator detection is `agentName === 'delegator'`.** The synthesis closure detects "is this child the delegator?" by `event.agentName === 'delegator'`; "is this an atom?" by `event.parentSessionId` matching the active delegator's `childSessionId`. This couples the wire events to the agent NAME, not the agent ROLE — the bundled `delegator.md` declares `role: delegator` and `name: delegator`, so they happen to coincide. Custom delegator agents must use the same agent name for the synthesis closure to recognize them.
3. **`delegator_plan` carries no upfront atom count.** The delegator dispatches atoms one at a time without pre-declaring a plan. `scheduledAtomCount` is reserved for a future synthesis variant that pre-plans the dispatch; v0 emits it as `undefined`. Consumers (TUI / drive / sov serve / sov dispatch) should render an ellipsis or progress-spinner instead of a hard count.
4. **`delegator_complete` carries `laneDistribution`.** The closure accumulates a lane-name → count map across the delegator's atoms and includes it in the close event. The map is empty when the delegator chose a trivial single-shot (one atom — its lane is in the map with count 1) or when nothing dispatched (rare error path).
5. **Success heuristic in `/routing-stats` is `outputTokens > 0`.** Approximates "atom produced an assistant message". Documented in `src/router/stats.ts` as a Phase 2.5 refinement candidate — a more reliable signal would be the terminal reason stored on the session row, which today is not persisted. Refinement gated on Phase 2.5 work that touches the session-completion path.
6. **`/routing-stats` from headless `sov dispatch` mode reports "not wired".** The dispatch command builds a minimal CommandContext without a sessionDb reader, so `ctx.getRoutingStats` is `undefined`. The command surfaces the friendly message instead of crashing. Operators who want stats from dispatch should query the SessionDb directly via `sov trace show` (which returns the parent → delegator → atom tree).
7. **Side-channel SSE event name on `sov serve`.** `event: hermes.delegator.progress\ndata: <json>\n\n` — matches the existing `event: hermes.tool.progress` convention from Phase 18. Side-channel events are NOT part of the OpenAI spec; harness-aware clients must explicitly subscribe to the `hermes.*` event-name family.
8. **Lane `timeoutMs` enforcement is now active.** Phase 1's R-D R-D follow-up shipped. Any lane configured with `timeoutMs: <N>` will see atoms dispatched to that lane interrupted after N milliseconds (the previously skipped `tests/router/atomTimeout.test.ts` is now active + green). Default `timeoutMs` is 120_000ms per lane; operators can shorten it per-lane in `taskRouting.lanes.<lane>.timeoutMs`.
9. **`SOV_TASK_ROUTING_ENABLED='0'` semantics are sharp.** Three-way: `'1'` enables, `'0'` disables, anything else falls through to config. The intent is to give operators a one-shot CI override without editing config. `'true'` / `'false'` / `'enable'` / etc. all fall through — only `'1'` and `'0'` flip the switch.
10. **No bundle changes in Phase 2.** Every bundle file is byte-identical to Phase 1. The Phase 2 surface is entirely in `src/`, `tests/`, and `packages/tui/` (plus this state file + usage doc + testing-log + CLAUDE/AGENTS pointer). This means `sov upgrade` to v0.5.0 only ships a new TS binary + new Go TUI binary; the bundle stays the same.

## Open follow-ups

(From Phase 2 implementation. The Phase 2.5 / Phase 3 items below are documented in the spec at `docs/specs/2026-05-23-multi-provider-task-routing-design.md`.)

1. **Quality escalation (Phase 2.5, conditional on soak).** Today the delegator never re-dispatches a failed atom. Phase 2.5 may add an escalation knob: when the cheap-task output looks off (heuristic on result length, error markers, etc.), the delegator can retry on moderate-task. Gated on Phase 2 soak surfacing real failure modes that warrant the complexity.
2. **Parent-model auto-downgrade (Phase 2.5, conditional on soak).** When `taskRouting.enabled: true`, the parent itself can run on a cheaper model since its only job is to relay the delegator's `summary`. Gated on Phase 2 telemetry showing the parent's prompt is small enough to justify the downgrade.
3. **Trivial-chat fast-path (Phase 2.5, conditional on soak).** Detect single-turn conversational replies upfront and skip the delegator entirely. Gated on soak data showing the delegator overhead on truly trivial turns is meaningful enough to bypass.
4. **Profile presets (Phase 2.5).** `taskRouting.profile: 'anthropic+local' | 'frugal' | 'mixed' | ...` that expands into the lane block. Lets operators get a sensible default without hand-editing every lane. Pure ergonomics; not gated on soak.
5. **Success heuristic refinement (Phase 2.5).** Move beyond `outputTokens > 0`. Candidate: persist `terminal: { reason, ... }` on the session row at completion time so the stats query can read it directly. Touches the agent-runner completion path; small refactor.
6. **Spend management (Phase 3).** Full per-lane token-cost tracking + budget caps + monthly ceilings + escalation gates. Gated on Phase 2 + Phase 2.5 soak validating the routing model first.
7. **`scheduledAtomCount` upfront in `delegator_plan`.** Reserve a future delegator-prompt variant that pre-plans the dispatch (e.g., "I'll run 3 atoms: ...") and surface the count in the plan event. Lets the TUI render a real progress count instead of an ellipsis. Not gated on anything; can ship anytime.
8. **Append Phase 2 entry to `docs/testing-log.md` (T11).** Followup task in this Phase 2 close-out chain.
9. **Cut v0.5.0 binary release with Phase 2 in it (T12).** Phase 2 is runtime-affecting (`src/`, `packages/tui/`); per `docs/conventions/cutting-releases.md` a release must be cut in the same session as the runtime changes so `~/.sov/bin/sov` picks them up.

## Postmortem-rule compliance check

The Phase 16.1 revert's Rules 1-4 (`docs/postmortems/2026-05-12-phase-16-revert.md`) apply primarily to foreground-surface refactors. Phase 2 is purely additive — no existing surface removed, no behavioral change to existing flows when `taskRouting.enabled: false` (the default) — so most rules don't engage:

- **Rule 1 (deprecation soak).** Waived. Nothing deprecated; nothing replaced. The TUI / drive / dispatch / cron / serve surfaces all continue to work identically. `taskRouting.enabled: false` (the default) preserves byte-identical behavior — the lane registry is still built, but no synthesis closure constructs (the runtime doesn't pass `delegationLifecycleRecorder` into the ToolContext when routing is off), no side-channel SSE writes, no `/routing-stats` data accrues.
- **Rule 2 (no helper deletion).** Satisfied. All changes are additive: new files (`src/router/progressEvents.ts`, `src/router/stats.ts`, `src/commands/routingStats.ts`, `packages/tui/internal/components/delegatorline.go`, `packages/tui/internal/transport/delegator_events.go`); two new optional callbacks on `DelegateInput`; two new optional fields on `ToolContext`; four new variants in `ServerEventSchema`; two new methods on `SessionDb`; one new env-var read site; four new cases in `EventRenderer.handle`; one new bus subscriber in the OpenAI streaming branch; one new slash command in the registry. No public surface removed.
- **Rule 3 (audit before claiming done).** Satisfied via layered tests: schema validation → synthesis-closure state machine (19 unit tests in `progressEvents.test.ts`) → e2e bus-flow integration (2 in `synthesisIntegration.test.ts`) → Go TUI decoders + formatters + app SSE switch (21 tests across 3 files) → `sov drive` renderer (5 tests) → `sov serve` side-channel (6 tests) → SessionDb queries (4 tests) → stats aggregator (8 tests) → `/routing-stats` command (7 tests) → end-to-end delegator integration tests augmented with bus subscriptions (+22 expects). T3's previously-skipped `atomTimeout.test.ts` is now unskipped and green, verifying R-D plumbing end-to-end through real scheduler + MockProvider slowMode.
- **Rule 4 (escape hatch).** Satisfied. `taskRouting.enabled: false` (the default) is a complete no-op for the smart-router code paths — and therefore for the new observability layer too. Even when enabled, side-channel SSE consumers can ignore the `hermes.delegator.progress` event name (it's outside the OpenAI spec). `SOV_TASK_ROUTING_ENABLED='0'` is a one-shot disable for CI runs. Lane `timeoutMs` can be set to `Number.MAX_SAFE_INTEGER` to effectively disable the timeout enforcement. All four cost-lane agents stay loaded in the registry even when `enabled: false` so `AgentTool` can still target them on demand (B-via-D bridge baseline from Phase 1, preserved).

## How it works now

After a few compound turns under `taskRouting.enabled: true`:

```text
> /routing-stats
routing stats — current session

total atoms:         5
overall success:     100.0%
overall avg duration: 2.3s

per-lane breakdown
  cheap-task     3 atoms (60.0%)  — 100.0% success  — 1.2s avg
  frontier-task  1 atom (20.0%)   — 100.0% success  — 4.8s avg
  moderate-task  1 atom (20.0%)   — 100.0% success  — 3.1s avg

> /routing-stats --all
routing stats — all sessions

total atoms:         42
overall success:     95.2%
overall avg duration: 2.1s

per-lane breakdown
  cheap-task     28 atoms (66.7%)  — 96.4% success  — 1.4s avg
  moderate-task  9 atoms (21.4%)   — 100.0% success  — 2.8s avg
  frontier-task  5 atoms (11.9%)   — 80.0% success  — 5.2s avg
```

In the TUI, a compound turn renders inline as a sequence of compact lines:

```text
◇ Delegating …
→ atom 0 on cheap-task: List the files in src/router/
✓ atom 0 on cheap-task (1234ms)
→ atom 1 on moderate-task: Summarize the test coverage matrix
✓ atom 1 on moderate-task (3142ms)
→ atom 2 on frontier-task: Synthesize a coverage-gap report
✓ atom 2 on frontier-task (4812ms)
◆ Done. 3 atoms: cheap-task=1, frontier-task=1, moderate-task=1
```

A failure path swaps the success glyph for the error glyph:

```text
◇ Delegating …
→ atom 0 on cheap-task: Look up the schema for User
✗ atom 0 on cheap-task failed (89ms)
→ atom 1 on frontier-task: Synthesize an answer noting the missing lookup
✓ atom 1 on frontier-task (4127ms)
◆ Done. 2 atoms: cheap-task=1, frontier-task=1
```

On `sov drive` the same flow prints as plain-text bracketed lines:

```text
[delegator_plan] dispatching
[delegator_atom 0] starting on cheap-task: List the files in src/router/
[delegator_atom 0] complete on cheap-task (1234ms) ok
[delegator_atom 1] starting on moderate-task: Summarize the test coverage matrix
[delegator_atom 1] complete on moderate-task (3142ms) ok
[delegator_atom 2] starting on frontier-task: Synthesize a coverage-gap report
[delegator_atom 2] complete on frontier-task (4812ms) ok
[delegator_complete] 3 atoms: cheap-task=1, frontier-task=1, moderate-task=1
```

On `sov serve` (the OpenAI HTTP API) the events flow as side-channel SSE frames interleaved with the main OpenAI-shaped stream:

```text
event: hermes.delegator.progress
data: {"type":"delegator_plan","seq":1,"sessionId":"openai:abc123","scheduledAtomCount":null}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk", ... ,"choices":[{"index":0,"delta":{"role":"assistant"}}]}

event: hermes.delegator.progress
data: {"type":"delegator_atom_started","seq":2,"sessionId":"openai:abc123","atomIndex":0,"laneName":"cheap-task","promptPreview":"List the files in src/router/"}

...

event: hermes.delegator.progress
data: {"type":"delegator_complete","seq":7,"sessionId":"openai:abc123","totalAtomCount":3,"laneDistribution":{"cheap-task":1,"moderate-task":1,"frontier-task":1}}
```
