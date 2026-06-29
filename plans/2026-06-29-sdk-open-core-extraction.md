# Sovereign AI SDK Open-Core Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Spec:** `specs/2026-06-29-sdk-open-core-extraction-design.md` (GREEN-LIT 2026-06-29). This plan expands spec §17.

**Goal:** Invert the harness into a lean, versioned, open-core SDK (`@yevgetman/sov-sdk`) that the harness/TUI and external apps are rebuilt *on*, with **zero feature regression**.

**Architecture:** Strangler refactor of a working 62K-LOC Bun/TypeScript product. The agent-loop engine becomes the open SDK; the four differentiated subsystems (learning, gateway, workflows, subscription-executor) become proprietary packages built on the SDK's public ports; the harness becomes a thin wrapper. The gate (`bun run lint && bun run typecheck && bun run test`) plus a new file-level boundary lint stays GREEN after every task — that green gate IS the zero-regression proof.

**Tech Stack:** Bun ≥1.2, TypeScript 5.6, Zod 3 (SDK core), Hono (gateway, proprietary), `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, Biome (formatting/lint), dependency-cruiser (new — the boundary lint).

## Global Constraints

- **Zero behavioral regression at every task.** The existing `bun test` suite must stay green after each task; it is the parity proof. Never edit a test to make it pass unless the test itself is provably wrong.
- **Bun-only v1.** No Node-compat work; `bun:sqlite` and Bun globals are allowed *in the proprietary/runtime layer only* — never in the open SDK dependency graph.
- **Lean SDK, no new concepts.** The SDK exposes the parameter surface `query()` already accepts; it must not absorb SSE, the approval queue, compaction policy, or live-reload.
- **Immutability:** new objects, never mutate caller inputs (the existing `query()` contract — `core/types.ts` "caller's message array is never mutated").
- **Commits:** atomic, one logical change per commit, conventional-commit format; push `origin/master` autonomously after each green task (harness AGENTS.md). Run the full gate before every commit.
- **Package names (ratified):** open core `@yevgetman/sov-sdk`; protocol `@yevgetman/sov-protocol`; existing proprietary `@yevgetman/sov`.
- **Contract #2 = pure `.d.ts`** (no zod in the protocol package) — CEO-ratified.
- **(B)-surface parity gap = FIX** (CEO-ratified): cron/channels/mission **gain** transcripts + microcompaction.
- **Subagent model:** Opus default; never Haiku; Sonnet only for trivially mechanical fully-specified relocations.
- **No week estimates** (harness convention) — sessions/dispatches only.

## Progressive elaboration

This is a 9-phase strangler; later phases depend on the exact API shapes earlier phases land. **Phase 1 is fully detailed below.** Phases 2–9 are specified at task granularity (files, interfaces, deliverable, verification) and are expanded to bite-sized steps *at execution time*, once their predecessor's surface is concrete — this avoids speculative placeholder steps. Each phase ends with the full gate + its phase-specific acceptance test green, then commit/push.

## New-file map (created across the build)

- `src/util/stall.ts`, `src/util/principals.ts`, `src/util/project.ts` — relocated pure leaves (Phase 1)
- `src/core/capabilities.ts` — relocated `findCapableModel` (Phase 1)
- `src/tool/ports.ts` — open port interfaces (`LearningObserverPort`, `ReviewManagerPort`, `TaskManagerPort`) + relocated `LaneRegistry`/`DelegationLifecycleEvent` types (Phase 1)
- `src/runtime/executorPort.ts` — `RunSubprocessExecutorOpts`/`SubprocessExecutorResult` open port types (Phase 1)
- `.dependency-cruiser.cjs` + `scripts/boundary-manifest.json` — the file-level boundary lint (Phase 1)
- `src/persistence/sessionStore.ts`, `src/persistence/inMemoryStore.ts`, `src/persistence/transcriptStore.ts` — ports (Phase 2)
- `src/sdk.ts` — the Contract #1 barrel (Phase 3)
- `src/agent/createAgent.ts` — the assembler (Phase 3)
- `packages/protocol/` — `@yevgetman/sov-protocol` (Phase 6)
- `packages/sdk/` — `@yevgetman/sov-sdk` physical package (Phase 8)
- `examples/embed/` — the external-import canary consumer (Phase 8)

---

## Phase 1 — Boundary prep + file-level boundary lint

**Outcome:** every open→proprietary edge is removed (relocated leaf, relocated type, or inverted port), and a file-level boundary lint passes GREEN and is wired into the gate. No behavioral change — the existing suite stays green throughout.

### Task 1.1: Relocate the pure-leaf helpers into `src/util/`

**Files:**
- Create: `src/util/stall.ts` (move body of `src/review/stall.ts` — verified 0 imports), `src/util/principals.ts` (move `validatePrincipalId` from `src/server/principals.ts:24`), `src/util/project.ts` (move `tryGitProjectId` from `src/learning/project.ts:52`)
- Modify importers: `src/core/query.ts:26` (`detectStall`/`TurnSummary` → `../util/stall.js`); `src/memory/bounded.ts:7` + `src/transcript/paths.ts:9` (`validatePrincipalId` → `../util/principals.js`); `src/memory/scope.ts:21` (`tryGitProjectId` → `../util/project.js`)
- Re-export shims (proprietary→open is allowed): `src/server/principals.ts` imports `validatePrincipalId` from `../util/principals.js` and re-exports (its `resolvePrincipal` stays); `src/learning/project.ts` imports `tryGitProjectId` from `../util/project.js` (its `getProjectId` keeps calling it); `src/review/stall.ts` re-exports from `../util/stall.js` if any proprietary importer remains, else delete.

**Interfaces — Produces:** `validatePrincipalId(id: string): void`, `tryGitProjectId(cwd: string): string | undefined`, `detectStall(...)` + `TurnSummary` — identical signatures, new open paths.

- [ ] **Step 1:** `grep -rn "review/stall\|server/principals\|learning/project" src tests` — record every importer before moving.
- [ ] **Step 2:** Move each body verbatim into the `src/util/` file; keep exports identical.
- [ ] **Step 3:** Update the open importers to the `../util/` path; add the proprietary re-export shims.
- [ ] **Step 4:** `bun run typecheck` — Expected: clean.
- [ ] **Step 5:** `bun run test` — Expected: green (pure moves, no behavior change).
- [ ] **Step 6:** Commit: `refactor(sdk): relocate pure-leaf helpers (stall/principals/project) to open util/`.

### Task 1.2: Relocate `findCapableModel` into the open core

**Files:**
- Create: `src/core/capabilities.ts` (move `findCapableModel` + its model-profile table from `src/router/capabilities.ts` — verified 0 imports)
- Modify: `src/runtime/scheduler.ts:34` import → `../core/capabilities.js`; `src/router/capabilities.ts` re-exports from `../core/capabilities.js` for any proprietary importer.

**Interfaces — Produces:** `findCapableModel(role, available)` — identical signature, open path.

- [ ] **Step 1:** `grep -rn "router/capabilities" src tests` — record importers.
- [ ] **Step 2:** Move the body; update `scheduler.ts`; add the re-export shim.
- [ ] **Step 3:** `bun run typecheck && bun run test` — Expected: green.
- [ ] **Step 4:** Commit: `refactor(sdk): relocate findCapableModel to open core`.

### Task 1.3: Relocate `RecallResult`; classify `TraceEvent`

**Files:**
- Modify: move `RecallResult` (and any sibling types `RecallTurn` returns) from `src/learning-layer/ports.ts` into open core (`src/core/types.ts` already defines `RecallTurn`; co-locate `RecallResult` there or in a new `src/core/recallPort.ts`). `src/learning-layer/ports.ts` re-exports from core. Remove `core/types.ts:8`'s import-from-proprietary.
- `TraceEvent` already lives in open `src/trace/types.ts` — no move; ensure `trace/` is on the open manifest and `TraceEvent` is barrel-exported (Phase 3).

- [ ] **Step 1:** Move `RecallResult` to core; invert the import (learning-layer imports from core). `grep -rn "learning-layer/ports" src` to update.
- [ ] **Step 2:** `bun run typecheck && bun run test` — green.
- [ ] **Step 3:** Commit: `refactor(sdk): relocate RecallResult to open core (invert learning-layer dep)`.

### Task 1.4: Replace ToolContext's proprietary class refs with open port interfaces

**Files:**
- Create: `src/tool/ports.ts` — `LearningObserverPort { observe(i: ObserveInput): void }`, `ReviewManagerPort` (the subset `ToolContext`/orchestrator call), `TaskManagerPort`, plus relocated pure types `LaneRegistry` and `DelegationLifecycleEvent` (moved from `router/laneRegistry.ts` / `router/progressEvents.ts`).
- Modify: `src/tool/types.ts:74,78,89,128,137-139` — `ToolContext` fields reference the port interfaces instead of `import('../tasks/manager.js').TaskManager` etc. The concrete proprietary classes already structurally satisfy these (verify with `tsc`).

**Interfaces — Produces:** the port interfaces in `src/tool/ports.ts`, consumed by `ToolContext` and (Phase 3) the SDK barrel.

- [ ] **Step 1:** Read `tasks/manager.ts`, `review/manager.ts`, `learning/observer.ts` to extract the exact method shapes `ToolContext` consumers call; define the minimal port interfaces.
- [ ] **Step 2:** Point `ToolContext` at the ports; relocate `LaneRegistry`/`DelegationLifecycleEvent` types; add re-export shims in `router/` if needed.
- [ ] **Step 3:** `bun run typecheck` — Expected: clean (the concrete classes satisfy the interfaces structurally). Fix any gap by widening the port to the real call surface.
- [ ] **Step 4:** `bun run test` — green.
- [ ] **Step 5:** Commit: `refactor(sdk): ToolContext depends on open port interfaces, not proprietary classes`.

### Task 1.5: Invert `runSubprocessExecutor` to a required injected port

**Files:**
- Create: `src/runtime/executorPort.ts` — move the `RunSubprocessExecutorOpts` + `SubprocessExecutorResult` types here (open); `subprocessExecutor.ts` imports them.
- Modify: `src/runtime/scheduler.ts:43` — **remove** the `defaultRunSubprocessExecutor` value import; make `runSubprocessExecutor` a **required** field on `SubagentSchedulerOpts` (drop the `?? defaultRunSubprocessExecutor` fallback at `:413`). Preserve the write-lock-scope coupling at `:282-285` (the `useSubprocessExecutor` gate stays — it now keys off whether the injected executor is the real one vs a native marker).
- Modify the scheduler's constructors (`buildRuntime` at `runtime.ts` + any test) to inject `runSubprocessExecutor` (proprietary supplies `runSubprocessExecutor` from `subprocessExecutor.ts`; tests inject a fake).

**Interfaces — Produces:** `SubagentSchedulerOpts.runSubprocessExecutor: (opts: RunSubprocessExecutorOpts) => Promise<SubprocessExecutorResult>` (required).

- [ ] **Step 1:** Write a failing test: a scheduler constructed with an injected fake `runSubprocessExecutor` routes a subscription-executor delegate through the fake AND still applies the narrow write-lock scope (assert the path-lock scope decision at `:282-285` is unchanged). Run: `bun test tests/.../scheduler-executor-port.test.ts` — Expected: FAIL (option not required yet).
- [ ] **Step 2:** Make `runSubprocessExecutor` required; remove the default import; update `buildRuntime` + existing tests to inject it.
- [ ] **Step 3:** Run the test — Expected: PASS. Run `bun run test` — Expected: green.
- [ ] **Step 4:** Commit: `refactor(sdk): invert subscription-executor to a required scheduler port (open scheduler)`.

### Task 1.6: Carve the proprietary `commands/*Ops.ts` files; relocate their result types

**Files:**
- Modify: relocate `WorkflowResult`/`WorkflowEvent` (from `workflows/`) and `RoutingStatsSnapshot` (from `router/stats.ts`) **result types** into open core (or accept these command files as proprietary). Mark `commands/pluginOps.ts`, `commands/reviewOps.ts`, `commands/workflowOps.ts`, `commands/routingStats.ts` as proprietary on the boundary manifest (they value/type-import proprietary modules). Confirm the remaining `commands/*` are clean.

- [ ] **Step 1:** `grep -rn "from '\.\./\(workflows\|router\|review\|plugins\)" src/commands` — enumerate every proprietary edge in `commands/`.
- [ ] **Step 2:** Relocate the pure *result types* to open core where an open file needs them; list the rest as proprietary-manifest files.
- [ ] **Step 3:** `bun run typecheck && bun run test` — green.
- [ ] **Step 4:** Commit: `refactor(sdk): carve proprietary commands/*Ops; relocate result types`.

### Task 1.7: Stand up the file-level boundary lint

**Files:**
- Create: `.dependency-cruiser.cjs` — a rule `no-open-to-proprietary`: files in the OPEN set may not import (value or type) from the PROPRIETARY set. Create `scripts/boundary-manifest.json` listing OPEN files/dirs + the file-level exceptions (`util/*`, `core/capabilities.ts`, the proprietary `commands/*Ops.ts`, `runtime/subprocessExecutor.ts` proprietary-in-open-dir, `server/principals.ts` re-export, etc.).
- Modify: `package.json` — add `"boundary": "depcruise src --config .dependency-cruiser.cjs"`; fold into the `lint` script and the pre-commit gate.
- Add dev dep: `dependency-cruiser`.

- [ ] **Step 1:** `bun add -d dependency-cruiser`. Author the config + manifest encoding the §4 disposition (OPEN dirs minus proprietary-file exceptions vs PROPRIETARY dirs plus open-file exceptions).
- [ ] **Step 2:** Run `bun run boundary` — Expected: GREEN (all crossings removed by Tasks 1.1–1.6). If any edge remains, fix it (relocate/invert) — do NOT add it to the allowlist.
- [ ] **Step 3:** Wire `boundary` into `lint`; run the full gate `bun run lint && bun run typecheck && bun run test` — green.
- [ ] **Step 4:** Commit: `feat(sdk): file-level open→proprietary boundary lint (gate)`.

### Task 1.8: Phase-1 acceptance

- [ ] Full gate green (`lint` incl. `boundary` + `typecheck` + `test`). Mark Phase 1 task complete; push.

---

## Phase 2 — SessionStore + TranscriptStore ports + config-object injection
**Deliverable:** `src/persistence/sessionStore.ts` (`SessionStore` interface — session lifecycle, save/load messages, `recordTokenUsage(sessionId, usage, estimatedCostUsd?)`), `inMemoryStore.ts` (`createInMemorySessionStore()` default), `transcriptStore.ts` (`TranscriptStore` interface). `SessionDb` (`bun:sqlite`) becomes one impl; `handle` getter stays off the port (TaskStore/compactor keep the concrete impl). Thread `settings?: Settings` through `RuntimeOptions`; tidy `resolver.ts:88` + `WebSearchTool.ts:61`. **Verify:** existing persistence tests green; a new test proves `createInMemorySessionStore()` round-trips a session with no `bun:sqlite`. **Elaborate to bite-sized at execution.**

## Phase 3 — createAgent() + PerTurn + RunResult + sdk.ts barrel
**Deliverable:** `src/agent/createAgent.ts` (`AgentConfig` standing + `PerTurn` override + `Agent.run()` returning structured `RunResult`, yielding `query()`'s stream unchanged — pinned by a sequence test), `buildToolContext(sessionId, opts)` promoted out of `server/routes/turns.ts`, `src/sdk.ts` barrel + `package.json` `exports` map, canonical tool descriptors, MCP pool port, `observe`→`LearningObserverPort` adapter, SessionStore persistence wiring, per-turn session pivot. **Verify:** a new test runs a turn via `createAgent` against a mock provider with no disk; the stream-passthrough invariant test passes; `buildToolContext` output snapshot matches the old `buildSessionToolContext`. **Elaborate at execution** (shape depends on Phase 2 ports).

## Phase 4 — Adopt createAgent() in the (B) in-process surfaces
**Deliverable:** OpenAI server, `sov mission run`, cron, channels, sub-agents each migrated onto `createAgent()`, one per task, each behind a field-level parity test. **FIX the parity gap:** cron/channels/mission gain transcripts + microcompaction via the new ports. **Verify:** per-surface parity test asserts the createAgent path forwards `recall`/`memoryManager`/`microcompactConfig`/`traceRecorder`/transcripts identically; mission run neither gains nor loses `learningObserver`/`subagentScheduler`/skill-filtering vs. an explicit diff. **Elaborate at execution.**

## Phase 5 — Re-seat workflows + subscription-executor
**Deliverable:** `workflows/engine.ts` swaps `buildSessionToolContext` for the SDK `buildToolContext` and the wide `Runtime` type for a narrow handle (`scheduler` + `buildToolContext` + `cwd`/`harnessHome`/`bundleRoot`); subscription-executor consumes the published type groups + canonical tool descriptors (its dispatch was carved out in Phase 1). **Verify:** the workflow E2E + the subscription-executor replay tests stay green. **Elaborate at execution.**

## Phase 6 — Extract Contract #2 (@yevgetman/sov-protocol, pure .d.ts)
**Deliverable:** `packages/protocol/` with the SSE event union + the six-endpoint request/response types authored as pure `.d.ts` (no zod), the 4 delegator schemas relocated out of `router/progressEvents.ts`, and a thin typed client. The gateway `server/` imports the protocol as the single source; the Go TUI `types.go` + (later) resume-as-code adopt it. **Verify:** a surface-snapshot test pins the protocol; the gateway still serves the identical wire shape (existing server tests green). **Elaborate at execution.**

## Phase 7 — Re-seat the gateway turn-exec onto agent.run() (hard step)
**Deliverable:** the single `query()` call at `turns.ts:745` re-seated onto `agent.run(messages, perTurn)` — the gateway computes `perTurn` each turn (provider/model/effort/tools/toolContext/memory/recall/microcompact/trace), keeps the compaction pivot + live-reload + approval-bus `canUseTool` rebind in proprietary orchestration; `mapStreamEventToServerEvent` consumes the unchanged stream. **Verify:** full suite + the enumerated Go-TUI E2E (turn/tools/recall/workflow/approval/micro+overflow compaction/skill-scope/channel/cron); a `/model`-swap-then-turn regression. **Elaborate at execution.**

## Phase 8 — Monorepo packages/ split + snapshots + example consumer
**Deliverable:** physical `packages/sdk/` (`@yevgetman/sov-sdk`) + `packages/protocol/` with own version lines + `exports` maps; `@yevgetman/sov` depends via workspace links through the public ports; surface-snapshot tests for both contracts; `examples/embed/` imports `createAgent` from the package, runs a no-disk turn, and CI-asserts no `bun:sqlite` in the open dep graph. **Verify:** the example consumer compiles + runs in CI; surface snapshots pinned. **Elaborate at execution.**

## Phase 9 — Rebuild harness entrypoint as the thin wrapper + ship
**Deliverable:** the harness entrypoint is a thin composition over `@yevgetman/sov-sdk` + the proprietary packages (the harness-from-SDK proof). **Verify:** the full §15 gate green; docs + `docs/06-testing/testing-log.md` updated; `sov upgrade`; commit/push; cut a release if applicable. **Elaborate at execution.**

---

## Self-review (run against the spec)

- **Spec coverage:** §17.1→Phase 1 (Tasks 1.1–1.8, all four leaf relocations + RecallResult + ToolContext ports + executor inversion + commands carve + boundary lint ✓); §6/§7→Phase 2 ✓; §5→Phase 3 ✓; §10→Phase 4 (with the ratified parity fix) ✓; §9→Phase 5 ✓; §8→Phase 6 (pure .d.ts ✓); §9/§16→Phase 7 ✓; §11/§12→Phase 8 ✓; §13.G/§15→Phase 9 ✓. No uncovered spec requirement.
- **Placeholder scan:** Phase 1 steps are concrete (exact files, greps, commands, expected output). Phases 2–9 are task-spec granularity with an explicit elaboration model — not placeholder steps within a claimed-complete phase.
- **Type consistency:** `SessionStore`/`TranscriptStore` (Phase 2) → consumed by `createAgent`/`PerTurn` (Phase 3) → consumed by (B) surfaces (Phase 4); `buildToolContext(sessionId, opts)` named identically across Phases 3/5/7; the executor port types (`RunSubprocessExecutorOpts`/`SubprocessExecutorResult`) named identically in Phase 1 (`executorPort.ts`) and consumed in Phase 5. Consistent.
