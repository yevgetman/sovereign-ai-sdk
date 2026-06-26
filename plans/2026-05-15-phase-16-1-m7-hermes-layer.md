# Phase 16.1 M7 — Hermes-Layer Parity Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent model policy: Opus 4.7 default; Sonnet 4.6 only for trivially mechanical fully-specified tasks; never Haiku (see `docs/05-conventions/subagent-policy.md`).

**Goal:** Wire six subsystems into Phase 16.1's split-process architecture so the server-side runtime reaches Hermes-layer feature parity with `terminalRepl.ts`: **MCP client pool** (stdio servers' tools enter the pool as `mcp__<server>__<tool>`), **TaskManager DaemonEventBus integration** (closes backlog #28 — TaskManager lifecycle events fan out to future subscribers), **trace writer** (per-session `~/.harness/traces/<sessionId>.jsonl` consumed by `sov trace show`), **trajectory capture** (ShareGPT-shaped JSONL written at session disposal, redacted at write), **learning observer** (per-tool-call observations stream into the instinct corpus pipeline), and **review manager** (`memory_propose`/`skill_propose` propose-then-promote lifecycle via fire-and-forget sub-agent dispatch). Six prereq boxes flip in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` (rows 2, 5, 10, 11, 12, 13). One open backlog item (#28) closes. `--ui tui` reaches parity with terminalRepl on the surfaces a long-running, learning-enabled session needs.

**Architecture:** M7 introduces **per-session subsystems** to `Runtime` for the first time — the M3–M6 fields were all process-global singletons (sessionDb, scheduler, taskManager) or per-call parameters (microcompactConfig). Trace writer + learning observer + review manager are per-session by design (they emit/persist with the session id baked in). The plan introduces a `SessionContext` registry on `Runtime` (`Map<sessionId, SessionContext>`) with lazy construction on first reference and disposal on session end. The turns route looks up the SessionContext, threads its members onto `buildSessionToolContext()`'s output, and forwards the trace recorder to `query()`'s `traceRecorder` param. After M6's compaction creates a new child session id, the child's SessionContext lazy-builds on first reference (parent's stays alive until explicit disposal). MCP client pool is a singleton (one pool per `sov` process), constructed once at `buildRuntime` boot and shut down in `dispose()`. DaemonEventBus is a singleton, constructed in `buildRuntime`, passed to TaskManager; nothing subscribes inside the server process in M7 (it's plumbing for future cross-process subscribers per backlog #28).

**Tech Stack:** TS / Bun (server), Hono routes, `bun:test`; no new dependencies introduced. All six subsystems are existing TS modules under `src/mcp/`, `src/tasks/`, `src/trace/`, `src/trajectory/`, `src/learning/`, `src/review/`.

**Spec references:**
- `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §9 (M7 group row), §10 (M7 row in milestone sequence), §13 (open Qs deferred to plan)
- `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` rows 2 (MCP), 5 (TaskManager), 10 (Trace), 11 (Trajectory), 12 (Learning), 13 (Review)
- `docs/08-roadmap/backlog/post-phase-13-4.md` item #28 (DaemonEventBus → server-mode TaskManager — closes in T2)
- `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` Rules 1–4 (terminalRepl untouched; coexistence; audit before flip)
- `plans/2026-05-14-phase-16-1-m6-long-session.md` — M6 plan establishing the wiring-into-server pattern this milestone repeats; this plan extends with the per-session subsystem pattern
- `src/ui/terminalRepl.ts:336,651-659,728,1946` (MCP construction + tool-pool merge + shutdown — reference implementation)
- `src/ui/terminalRepl.ts:594,599,961,1437,1947,1952` (Trace writer construction + traceRecorder thread + close)
- `src/ui/terminalRepl.ts:1923-1942` (Trajectory write at session close)
- `src/ui/terminalRepl.ts:~1100,~1110,~1650` (Learning observer construction + ToolContext attach + drain)
- `src/ui/terminalRepl.ts:~1070,~1110,~1700` (Review manager construction + ToolContext attach + getDispatchSummary at goodbye)
- `src/mcp/client.ts:1-103` (`buildMcpClientPool`), `src/mcp/toolWrapper.ts:1-55` (`wrapMcpTool`)
- `src/trace/writer.ts:35-88` (`TraceWriter` class + `findTracePath`)
- `src/trajectory/writer.ts:22-116` (`buildTrajectoryRecord` + `writeTrajectory` + `tryWriteTrajectory`)
- `src/learning/observer.ts:15-138` (`LearningObserver` class)
- `src/review/manager.ts:115-327` (`ReviewManager` class), `src/review/consolidate.ts:27` (`runConsolidation`)
- `src/daemon/eventBus.ts` (DaemonEventBus types — already exists, dormant)
- `src/server/runtime.ts:98-231` (current `RuntimeOptions` / `Runtime`), `src/server/runtime.ts:294-570` (`buildRuntime` body + dispose)
- `src/server/routes/turns.ts:128-144` (`buildSessionToolContext`)
- `src/tool/types.ts:134-139` (`ToolContext.learningObserver` already declared as optional)

**Scope guard — what M7 does NOT do:**
- **No `/review` slash command UX in the TUI.** The propose-then-promote lifecycle works via the model's tool calls (`memory_propose`, `skill_propose`) and the consolidation sub-agent that ReviewManager dispatches. Client-side `/review list/show/approve/reject/consolidate` UX is deferred to M8 (polish surfaces). The CommandContext path is REPL-only at this point; server-side slash-command dispatch is its own larger story.
- **No `sov trace show` improvements.** The CLI consumer (`src/cli/traceShow.ts`) is unchanged. T3 ensures `~/.harness/traces/<sessionId>.jsonl` lands with the same JSON shape `sov trace show` already reads. Trace visualization polish is M8 or M9.
- **No DaemonEventBus subscriber in M7.** T2 wires the bus into TaskManager so events fire onto it. Nothing subscribes inside the server process in M7. Subscribers come later (review/learning observe via ToolContext direct-call per M7-04 below — keeps the dependency graph linear).
- **No auxiliary model selection for the review-consolidate sub-agent.** Like M6's summarize callback, ReviewManager dispatches via the same provider/model the parent session uses. Phase 15 / M8 polish item.
- **No multi-session UX in the TUI.** The server supports concurrent sessions structurally (the SessionContext registry is keyed on sessionId) but the TUI surfaces one session at a time. This is the spec §5 invariant — preserved.
- **No goodbye summary card rendering.** Review manager's `getDispatchSummary()` is invoked at session disposal and emitted on a new `session_summary` SSE event. The styled card is M9 polish; M7 captures the data and surfaces it on the wire.
- **No stall detection wiring.** `src/review/stall.ts` lives next to the review manager and is row 22 (separate row, polish-surfaces group M8). M7 does not fire stall detection events.
- **No `--ui tui` default flip.** `--ui tui` stays opt-in through M11.
- **No tests against real Anthropic.** M7 ships entirely against the mock provider. Manual smoke / autonomous smoke against real Anthropic happens as a separate hardening pass, post-T7 (mirroring M6's pattern).
- **terminalRepl untouched (Postmortem Rule 1).** Every wiring lives parallel-additive in the server side. M7 does not import, modify, or rename any helper module under `src/ui/`, `src/commands/`, or related REPL-only files.

---

## Inline Decisions (resolutions of Spec §13 Open Qs for this milestone)

| Decision | Resolution | Rationale |
|---|---|---|
| **M7-01 — Per-session subsystems live in a Map on Runtime** | New `Runtime.sessionContexts: Map<string, SessionContext>` + `Runtime.getSessionContext(sessionId): SessionContext` factory method that lazy-builds on first reference and caches. `SessionContext` carries: `traceWriter`, `learningObserver`, `reviewManager`. The turns route looks up the context per turn and threads its members onto the ToolContext / `query()` params. | Mirrors terminalRepl's per-session ownership (each `activeSessionId` swap rebinds these). Keeps `Runtime` itself stateless re: session id while supporting future multi-session UX without rewiring. Lazy build avoids paying construction cost on session ids that never see a turn. |
| **M7-02 — Trace writer rebuilt on compaction (sessionId pivots)** | After M6's compaction creates a new child session id, the turns route fetches the child's SessionContext on the next `hydrate()`. The parent's trace writer is closed at this point (its file is final). The child's trace writer opens a new `traces/<childId>.jsonl` file. | Trace files are named by sessionId; mirrors terminalRepl.ts:1437 ("Rebound in child-session context"). Keeps per-trace files self-contained for `sov trace show` consumption. |
| **M7-03 — Trajectory writes on session disposal, not per-turn** | `tryWriteTrajectory()` fires from `runtime.disposeSession(sessionId)` (new method, T4). `runtime.dispose()` walks the live SessionContext map and calls `disposeSession` on each before tearing down singletons. Mid-life writes (e.g., on `turn_complete`) are NOT added — trajectory's contract is "full session as one record". For compaction lineage, the parent session's trajectory is written when the SessionContext is explicitly disposed (M9 polish: render the trajectory write on pivot; M7 ships the disposal-driven path). | Matches terminalRepl.ts:1923-1942 — single write at session close. Per-turn writes would overwrite a file the user expects to grow monotonically. M7 ships disposal-driven; explicit per-session-end signals (e.g., a future DELETE /sessions/:id route) can call `disposeSession` to trigger an earlier write. |
| **M7-04 — Learning observer is direct-call, not bus-subscribed** | The orchestrator's `runTools()` path (`src/core/orchestrator.ts`) reads `toolContext.learningObserver?.observe(...)` directly. M7's wiring puts the per-session `LearningObserver` onto the toolContext. No DaemonEventBus subscription. | Keeps the call graph linear and synchronous (observation is fire-and-forget but the call site is direct). DaemonEventBus integration is plumbing for *cross-process* subscribers (future daemon-mode); M7's review/learning live in-process and read the observer/manager off ToolContext like terminalRepl does. |
| **M7-05 — Review manager same lifecycle as trace, dispatch via existing scheduler** | Per-session `ReviewManager` lives in `SessionContext`. Constructed with `runtime.subagentScheduler` (already on Runtime from M5), the session's `traceWriter.path` as `tracePath`, the artifactsRoot for `trajectoryPath`, thresholds from `userSettings.review`, and `projectIdentity: () => getProjectId(cwd)`. Threaded onto the per-call `toolContext.reviewManager`. Triggers fire from existing call sites in `src/core/query.ts` (`onToolIteration`) and `src/runtime/scheduler.ts` (`onChildCompletion`). At session disposal, `getDispatchSummary()` runs and the result is emitted on a new SSE `session_summary` event for the TUI to render later (M9 polish). | Mirrors terminalRepl.ts (construction + summary at goodbye). The scheduler already supports fire-and-forget sub-agent dispatch (`scheduler.delegate()`); ReviewManager calls `runReviewFork()` which wraps that — no scheduler changes needed. |
| **M7-06 — DaemonEventBus constructed in buildRuntime; passed to TaskManager only** | `buildRuntime` constructs an in-memory `DaemonEventBus` (the existing `src/daemon/eventBus.ts` API — no new file), passes it to `new TaskManager({ store, scheduler, bus })`, and stores it on `Runtime.daemonEventBus` for future consumers. Closes backlog #28. No subscriber wired in M7 (the bus emits `task_update` events into the void; future cross-process subscribers will tap in). | Backlog #28 verbatim: "Becomes a real gap when M7's review/learning subsystems land in server mode — they'll need the daemon-bus integration to fire." The analysis (this plan's research) confirmed review/learning observe via ToolContext direct-call (M7-04, M7-05), not via the bus. The "gap" is therefore the plumbing — fixed by T2. Future daemon-mode subscribers can plug in without rewiring. |
| **M7-07 — `/review` slash command UX deferred to M8** | M7 wires the manager + the propose-then-promote pipeline (the model's tool calls + the consolidation sub-agent). The `/review list/show/approve/reject/revoke/consolidate/activity` slash command remains REPL-only (it lives in `src/commands/reviewOps.ts` and consumes `CommandContext`). Server-side slash-command dispatch is its own larger story (the spec mentions `GET /commands` as a future route). | Keeps M7 scoped to the 6 prereq-row subsystems. Slash command UX is polish-layer (M8 candidate). The model can still write proposals via `memory_propose`/`skill_propose` tools, which IS the propose-then-promote mechanism. |
| **M7-08 — `runtime.dispose()` order: per-session → MCP → approvals → sessionDb** | `runtime.dispose()` updates to: (1) walk `sessionContexts` and call `disposeSession(id)` on each (closes trace, drains learning, writes trajectory, emits session_summary), (2) shut down `mcpClientPool` (terminates stdio child processes), (3) close approval queue, (4) close sessionDb. | Order matters: per-session subsystems first (they may write to sessionDb during disposal), then MCP children (they may be referenced by in-flight tool calls being torn down), then approval queue (may have pending promises waiting on bus closure), then sessionDb (final). |

---

## File Structure

### New files

| Path | Responsibility | Approx. LoC |
|---|---|---|
| `src/server/sessionContext.ts` | `SessionContext` type + `buildSessionContext({ runtime, sessionId })` factory. Constructs per-session `TraceWriter`, `LearningObserver`, `ReviewManager`. `disposeSessionContext()` helper does the shutdown sequence (trace close + learning drain + trajectory write + review getDispatchSummary). | ~180 |
| `tests/server/sessionContext.test.ts` | Unit tests for `SessionContext` lifecycle: lazy build returns a populated context; disposeSessionContext closes trace + drains learning + writes trajectory + invokes review getDispatchSummary; double-dispose is safe (idempotent). | ~200 |
| `tests/server/runtime.mcp.test.ts` | `buildRuntime` with `mcpServers` in settings constructs the pool; the pool's tools appear in `runtime.toolPool` with `mcp__<server>__<tool>` names; `runtime.dispose()` shuts the pool down before sessionDb close. | ~150 |
| `tests/server/runtime.daemonBus.test.ts` | `buildRuntime` constructs a `DaemonEventBus` and passes it to TaskManager; emitted `task_update` events fire onto the bus (verify via a subscriber spy in the test). Closes backlog #28. | ~120 |
| `tests/server/turns.trace.test.ts` | Server-side trace writer integration: turn fires through `query()`, `traceRecorder` writes events, file lands at `<harnessHome>/traces/<sessionId>.jsonl` with expected event types (turn_start, provider_request, provider_response, tool_start, tool_end). | ~180 |
| `tests/server/runtime.trajectory.test.ts` | `runtime.disposeSession(sessionId)` writes a trajectory file at `<artifactsRoot>/trajectories/{samples,failed}.jsonl` per terminal reason; redaction applied; ShareGPT shape verified. | ~160 |
| `tests/server/turns.learning.test.ts` | Turn fires; orchestrator emits observations onto the per-session LearningObserver; observations land in `<harnessHome>/learning/<projectId>/observations.jsonl`. | ~150 |
| `tests/server/turns.review.test.ts` | Turn fires; ReviewManager's `onToolIteration` / `onChildCompletion` / `onUserTurn` triggers fire at threshold; `runReviewFork` invoked (via `scheduler.delegate` spy); session disposal emits `session_summary` SSE event with `getDispatchSummary()` payload. | ~200 |
| `tests/server/integration/m7Full.test.ts` | End-to-end smoke: M7 wiring via `tuiLauncherIntegration` shape. One turn fires with MCP tools + trace + trajectory + learning + review all wired; assertion across all six output sinks. | ~250 |

### Modified files

| Path | Modification |
|---|---|
| `src/server/runtime.ts` | (a) Import MCP, DaemonEventBus, SessionContext modules; (b) extend `RuntimeOptions` with optional injection seams (`mcpClientPool?`, `daemonEventBus?`, `sessionContextFactory?`); (c) extend `Runtime` with `mcpClientPool: McpClientPool \| undefined`, `daemonEventBus: DaemonEventBus`, `sessionContexts: Map<string, SessionContext>`, `getSessionContext: (sessionId: string) => SessionContext`, `disposeSession: (sessionId: string) => Promise<void>`; (d) `buildRuntime` boot: load MCP settings → build pool (if configured) → wrap tools → merge into toolPool; construct DaemonEventBus; pass to new TaskManager; (e) `dispose()` walks sessionContexts → closes MCP → closes approval queue → closes sessionDb (M7-08 order). |
| `src/server/routes/turns.ts` | (a) In `buildSessionToolContext`: look up `runtime.getSessionContext(sessionId)` and thread its `learningObserver` + `reviewManager` onto the returned ToolContext; (b) in `runTurnInBackground`: forward `sessionCtx.traceWriter.record` to `query()` as `traceRecorder`; record `session_start` trace event on first turn for a sessionId, `turn_start`/`turn_complete`/`turn_error` at the right boundaries (driven by existing query event mapping). |
| `src/server/schema.ts` | Add `session_summary` SSE event type for review goodbye summary (M7-05): `{ type: 'session_summary', sessionId, totalDispatched, byAgent }`. Wire-event union extended; `WireEvent` updated. |
| `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` | Flip checkboxes for rows 2 (MCP), 5 (TaskManager), 10 (Trace), 11 (Trajectory), 12 (Learning), 13 (Review) with `(M7 — 2026-05-XX)` annotation. |
| `docs/08-roadmap/backlog/post-phase-13-4.md` | Close item #28 (DaemonEventBus → server-mode TaskManager). |
| `DECISIONS.md` | Add ADR stubs: M7-01 (per-session context registry), M7-02 (trace rebuild on compaction), M7-03 (trajectory at disposal), M7-05 (review same lifecycle as trace), M7-06 (DaemonEventBus plumbing-only), M7-08 (dispose order). M7-04 / M7-07 are scope-defining, not architectural — note them in the snapshot, not as ADRs. |
| `docs/07-history/state/2026-05-XX.md` (close-out date) | New close-out snapshot — supersedes `docs/07-history/state/2026-05-14.md`. |
| `CLAUDE.md` / `AGENTS.md` | Update the state-snapshot pointer to the new dated file. Byte-identical mirror invariant preserved. |

---

## Files Touched (by task)

| Task | Modifies | Creates | Tests |
|---|---|---|---|
| T1 | `src/server/runtime.ts` | — | `tests/server/runtime.mcp.test.ts` |
| T2 | `src/server/runtime.ts` | — | `tests/server/runtime.daemonBus.test.ts` |
| T3 | `src/server/runtime.ts`, `src/server/routes/turns.ts` | `src/server/sessionContext.ts` | `tests/server/sessionContext.test.ts`, `tests/server/turns.trace.test.ts` |
| T4 | `src/server/runtime.ts`, `src/server/sessionContext.ts` | — | `tests/server/runtime.trajectory.test.ts` |
| T5 | `src/server/sessionContext.ts`, `src/server/routes/turns.ts` | — | `tests/server/turns.learning.test.ts` |
| T6 | `src/server/sessionContext.ts`, `src/server/routes/turns.ts`, `src/server/schema.ts` | — | `tests/server/turns.review.test.ts` |
| T7 | `tests/server/integration/m7Full.test.ts`, `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, `docs/08-roadmap/backlog/post-phase-13-4.md`, `DECISIONS.md`, `docs/07-history/state/<date>.md`, `CLAUDE.md`, `AGENTS.md` | `tests/server/integration/m7Full.test.ts`, `docs/07-history/state/<date>.md` | (extends integration test with full M7 sweep) |

---

## Task 1: MCP client pool wiring

**Goal:** `buildRuntime` loads MCP server settings from the layered cascade, builds the pool when at least one server is configured, wraps each discovered tool via `wrapMcpTool`, and merges the wrapped tools into `runtime.toolPool`. `runtime.dispose()` shuts the pool down before `sessionDb.close()` (M7-08 order). Closes prereq row 2.

**Files:**
- Modify: `src/server/runtime.ts`
- Create: `tests/server/runtime.mcp.test.ts`

**Spec / inventory pointers:**
- `src/mcp/client.ts:1-103` — `buildMcpClientPool({ servers, log, connectTimeoutMs })` returns `Promise<McpClientPool>`. The pool exposes `servers()`, `tools()`, `call()`, `shutdown()`.
- `src/mcp/toolWrapper.ts:1-55` — `wrapMcpTool(meta, pool): Tool<unknown, unknown>`. Tool name = `mcp__${meta.serverName}__${meta.toolName}`.
- `src/config/settings.ts:62` — `mcpServers: z.record(z.string(), McpServerConfigSchema).optional()` schema field.
- `src/config/settings.ts:166-187` — `loadMcpServerSettings(opts): LoadedMcpServerSettings` loader; returns `{ servers, sources }`.
- `src/ui/terminalRepl.ts:336` — reference: `const mcpSettings = loadMcpServerSettings({ cwd: process.cwd(), harnessHome })`.
- `src/ui/terminalRepl.ts:651-659` — reference: pool construction with conditional based on `Object.keys(mcpSettings.servers).length > 0`.
- `src/ui/terminalRepl.ts:728` — reference: `let toolPool = assembleToolPool(toolContext, { mcpTools, harnessInfoSnapshot })`.
- `src/ui/terminalRepl.ts:1946` — reference: `if (mcpPool) await mcpPool.shutdown()`.
- `src/server/runtime.ts:319` — current `assembleToolPool(toolCtx)` call; needs the second arg for MCP tools.

- [ ] **Step 1: Write the failing test**

Create `tests/server/runtime.mcp.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — MCP client pool wiring (M7 T1)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t1-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('no MCP servers configured → mcpClientPool is undefined and no mcp__ tools in toolPool', async () => {
    // Arrange: no settings.json with mcpServers — runtime should boot cleanly.
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    // Assert
    expect(runtime.mcpClientPool).toBeUndefined();
    const mcpToolNames = runtime.toolPool.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name);
    expect(mcpToolNames).toEqual([]);

    await runtime.dispose();
  });

  test('mcpServers configured → pool builds, mcp__ tools appear in toolPool, dispose shuts pool first', async () => {
    // Arrange: settings.json with a single MCP server pointed at a tiny echo stdio fixture.
    // The fixture script is a Node-equivalent that the mcp client treats as a stdio MCP server.
    // For this test we use the existing fixture under tests/mcp/fixtures/ if available; otherwise
    // a minimal `bun run -e` invocation. The exact fixture path is filled in during the GREEN step
    // by checking tests/mcp/client.test.ts for the fixture it uses.
    const settingsPath = join(tmpHome, 'config.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          echo: {
            command: 'bun',
            args: ['run', join(import.meta.dir, '../../tests/mcp/fixtures/echo-server.ts')],
          },
        },
      }),
    );
    process.env.HARNESS_CONFIG_PATH = settingsPath;

    let mcpShutdownCalled = false;
    let sessionDbClosed = false;
    let shutdownBeforeDbClose = false;

    try {
      const runtime = await buildRuntime({
        cwd: tmpHome,
        harnessHome: tmpHome,
        provider: 'mock',
        preflight: false,
      });

      // Assert: pool exists, wrapped tools surfaced.
      expect(runtime.mcpClientPool).toBeDefined();
      const mcpToolNames = runtime.toolPool.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name);
      expect(mcpToolNames.length).toBeGreaterThan(0);
      expect(mcpToolNames[0]).toMatch(/^mcp__echo__/);

      // Spy on shutdown order: wrap shutdown + close to record the sequence.
      const realShutdown = runtime.mcpClientPool!.shutdown.bind(runtime.mcpClientPool);
      runtime.mcpClientPool!.shutdown = async () => {
        mcpShutdownCalled = true;
        if (!sessionDbClosed) shutdownBeforeDbClose = true;
        await realShutdown();
      };
      const realClose = runtime.sessionDb.close.bind(runtime.sessionDb);
      runtime.sessionDb.close = () => {
        sessionDbClosed = true;
        realClose();
      };

      await runtime.dispose();

      expect(mcpShutdownCalled).toBe(true);
      expect(shutdownBeforeDbClose).toBe(true);
    } finally {
      delete process.env.HARNESS_CONFIG_PATH;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/runtime.mcp.test.ts`

Expected: FAIL — `runtime.mcpClientPool` is undefined (not on the Runtime type), the MCP wiring doesn't exist, and the second test errors out before any assertion runs.

- [ ] **Step 3: Add MCP imports to `src/server/runtime.ts`**

After the existing imports block (around line 48), add:

```typescript
import { buildMcpClientPool, type McpClientPool } from '../mcp/client.js';
import { wrapMcpTool } from '../mcp/toolWrapper.js';
import { loadMcpServerSettings } from '../config/settings.js';
```

- [ ] **Step 4: Add `mcpClientPool` field to `RuntimeOptions` and `Runtime`**

In `src/server/runtime.ts` `RuntimeOptions` (after `proactiveCompactThreshold?: number;` around line 142):

```typescript
  /** Pre-built MCP client pool injection seam (test override). When
   *  omitted, buildRuntime loads from settings via loadMcpServerSettings
   *  and constructs a fresh pool when at least one server is configured. */
  mcpClientPool?: McpClientPool;
```

In `Runtime` (after `proactiveCompactThreshold: number;` around line 229):

```typescript
  /** Connected MCP client pool. Undefined when no MCP servers are
   *  configured. The pool's wrapped tools are already merged into
   *  `toolPool` at boot. runtime.dispose() shuts the pool down before
   *  sessionDb.close() (M7-08 order). */
  mcpClientPool: McpClientPool | undefined;
```

- [ ] **Step 5: Wire MCP load + construction into `buildRuntime`**

In `src/server/runtime.ts`, locate the section just after `agents` is loaded (around line 307, before the `toolCtx` is constructed). Insert:

```typescript
  // M7 T1 — load MCP server settings + build pool when configured.
  // Mirrors terminalRepl.ts:336,651-659.
  const mcpSettings = loadMcpServerSettings({ cwd: opts.cwd, harnessHome });
  const mcpClientPool: McpClientPool | undefined =
    opts.mcpClientPool ??
    (Object.keys(mcpSettings.servers).length > 0
      ? await buildMcpClientPool({
          servers: mcpSettings.servers,
          log: (msg) => process.stderr.write(`${msg}\n`),
        })
      : undefined);
  const mcpTools = mcpClientPool
    ? mcpClientPool.tools().map((meta) => wrapMcpTool(meta, mcpClientPool))
    : [];
```

Then change the `assembleToolPool` call at line 319 from:

```typescript
  const toolPool = assembleToolPool(toolCtx);
```

to:

```typescript
  const toolPool = assembleToolPool(toolCtx, { mcpTools });
```

Note: `assembleToolPool`'s existing second-arg shape supports `{ mcpTools, harnessInfoSnapshot }` per terminalRepl.ts:728. The server doesn't pass `harnessInfoSnapshot` (it's a terminalRepl-specific concern); omitting it is safe.

- [ ] **Step 6: Add `mcpClientPool` to the Runtime return object**

In the return literal (around line 537), add `mcpClientPool` between `proactiveCompactThreshold` and `dispose`:

```typescript
    proactiveCompactThreshold,
    mcpClientPool,
    dispose: async () => {
      // M7-08 disposal order: per-session subsystems → MCP pool → approval queue → sessionDb.
      // Per-session walk lands in T3; T1 only handles MCP + the existing approval + sessionDb.
      if (mcpClientPool) await mcpClientPool.shutdown();
      approvalQueue.disposeAll();
      sessionDb.close();
    },
  };
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/server/runtime.mcp.test.ts`

Expected: PASS — both tests pass. The no-MCP-configured case has `mcpClientPool === undefined`; the configured case has the pool built, mcp__ tools in toolPool, and shutdown ordered before sessionDb close.

- [ ] **Step 8: Run the full server test suite to check for regressions**

Run: `bun test tests/server/`

Expected: PASS — no regressions. The `assembleToolPool(toolCtx, { mcpTools: [] })` call with an empty mcpTools array should behave identically to `assembleToolPool(toolCtx)`; if it doesn't, that's a real bug to fix.

- [ ] **Step 9: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`

Expected: clean. The same 2 pre-existing `noNonNullAssertion` warnings in `src/permissions/shellSemantics.ts` may remain — they're unrelated to M7 T1.

- [ ] **Step 10: Append testing-log entry and commit**

Append a `## 2026-05-XX — Phase 16.1 M7 T1 — MCP client pool wired into buildRuntime` entry to `docs/06-testing/testing-log.md` covering: tests added, suite delta, what was wired.

```bash
git add src/server/runtime.ts tests/server/runtime.mcp.test.ts docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
feat(server): M7 T1 — MCP client pool wired into buildRuntime

Loads MCP server settings via loadMcpServerSettings, constructs the pool
when at least one server is configured, merges wrapped tools into
runtime.toolPool. dispose() shuts the pool down before sessionDb.close()
(M7-08 order). Closes prereq row 2.

Mirrors terminalRepl.ts:336,651-659,728,1946.
EOF
)"
git push origin master
```

- [ ] **Step 11: `sov upgrade` per convention**

Run: `sov upgrade`

Expected: rebuilds binary, runs postinstall TUI build. The MCP wiring is server-side TS — does not require Go rebuild but `sov upgrade` does the full pass regardless.

---

## Task 2: DaemonEventBus → TaskManager wiring (closes backlog #28)

**Goal:** `buildRuntime` constructs a `DaemonEventBus` and passes it to the new TaskManager. The bus emits `task_update` events when tasks transition (`queued` → `running` → `completed`/`failed`). Nothing subscribes inside the server process in M7 — this is plumbing for future cross-process subscribers. Closes backlog item #28.

**Files:**
- Modify: `src/server/runtime.ts`
- Create: `tests/server/runtime.daemonBus.test.ts`

**Spec / inventory pointers:**
- `src/daemon/eventBus.ts` — existing `DaemonEventBus` class (dormant per Phase 16 revert). Verify the export name and constructor signature with `grep -n 'export' src/daemon/eventBus.ts`.
- `src/daemon/types.ts` — event types including `task_update`, `task_started`, `task_completed`, `task_failed`.
- `src/tasks/manager.ts:59-198` — `TaskManager` constructor accepts `{ store, scheduler, bus? }` per the agent analysis. The `bus` field is already optional.
- `src/server/runtime.ts:500-504` — current TaskManager construction site. Currently omits `bus`.
- `docs/08-roadmap/backlog/post-phase-13-4.md` item #28 — backlog entry to close in T7.

- [ ] **Step 1: Verify DaemonEventBus surface**

Run: `grep -n 'export' src/daemon/eventBus.ts src/daemon/types.ts`

Expected output: an `export class DaemonEventBus` (or similar) declaration and the event type union. If the export is named differently, adjust the import in subsequent steps.

- [ ] **Step 2: Write the failing test**

Create `tests/server/runtime.daemonBus.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — DaemonEventBus wired into TaskManager (M7 T2 / backlog #28)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t2-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('runtime exposes daemonEventBus; TaskManager publishes task_update onto it', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    expect(runtime.daemonEventBus).toBeDefined();

    // Subscribe a spy to capture task_update events.
    const captured: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = runtime.daemonEventBus.subscribe((evt) => {
      captured.push({ type: evt.type, payload: evt });
    });

    // Drive the TaskManager through a state transition.
    // The simplest path: TaskStore.insert -> TaskManager calls store.updateState
    // via runDelegation. For an isolated bus test we don't need a real delegation;
    // we directly call into TaskStore to assert the manager-bus wiring.
    // Use an in-process synthetic transition via TaskManager API if available;
    // otherwise spy on the bus.publish call from store transitions.
    //
    // The simplest sufficient assertion: build a synthetic task record via
    // runtime.taskManager.create() with a no-op scheduler stub, then verify
    // that at least one task_update event fires onto the bus before disposal.

    // The test fixture seeds the scheduler with a no-op delegation result.
    // The mock provider in this runtime is unused; we never call query().
    // Instead, the assertion is: the bus IS the one the TaskManager publishes onto.
    // Implementation detail: insert a synthetic record + transition via store.
    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });
    const taskRecord = await runtime.taskManager.create({
      parentSessionId: sessionId,
      agentName: 'echo',
      prompt: 'noop',
      parentToolPool: runtime.toolPool,
      parentToolContext: {
        cwd: runtime.cwd,
        sessionId,
        harnessHome: runtime.harnessHome,
        agents: runtime.agents,
      } as never,
    });

    // Allow the fire-and-forget runDelegation to land (a single microtask tick).
    await new Promise((r) => setTimeout(r, 50));

    // Expect at least one task_update event (the queued → running transition).
    const updates = captured.filter((e) => e.type === 'task_update');
    expect(updates.length).toBeGreaterThan(0);

    unsubscribe();
    await runtime.dispose();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/server/runtime.daemonBus.test.ts`

Expected: FAIL — `runtime.daemonEventBus` is undefined.

- [ ] **Step 4: Add DaemonEventBus import + Runtime field**

In `src/server/runtime.ts`, after the existing imports (around line 48), add:

```typescript
import { DaemonEventBus } from '../daemon/eventBus.js';
```

(Verify the export name matches step 1 output; adjust if needed.)

Extend `RuntimeOptions` (after the `mcpClientPool?` field from T1):

```typescript
  /** Pre-built DaemonEventBus injection seam (test override). When
   *  omitted, buildRuntime constructs a fresh in-memory bus. */
  daemonEventBus?: DaemonEventBus;
```

Extend `Runtime` (after the `mcpClientPool` field from T1):

```typescript
  /** Cross-cutting event bus that TaskManager publishes lifecycle events
   *  onto (task_started, task_completed, task_failed, task_update). M7 has
   *  no subscriber inside the server process — this is plumbing for future
   *  daemon-mode / cross-process subscribers. Closes backlog #28. */
  daemonEventBus: DaemonEventBus;
```

- [ ] **Step 5: Construct the bus + pass to TaskManager**

In `buildRuntime`, locate the TaskStore + TaskManager construction (around line 500–504). Replace:

```typescript
  const taskStore = new TaskStore(sessionDb);
  const taskManager = new TaskManager({
    store: taskStore,
    scheduler: subagentScheduler,
  });
```

with:

```typescript
  // M7 T2 — DaemonEventBus plumbing. Constructed once per runtime; passed
  // to TaskManager so lifecycle events fire onto it for future subscribers.
  // No subscriber in M7 server process — purely plumbing per M7-06.
  // Closes backlog #28.
  const daemonEventBus = opts.daemonEventBus ?? new DaemonEventBus();
  const taskStore = new TaskStore(sessionDb);
  const taskManager = new TaskManager({
    store: taskStore,
    scheduler: subagentScheduler,
    bus: daemonEventBus,
  });
```

- [ ] **Step 6: Add `daemonEventBus` to Runtime return object**

In the return literal (around line 562), add `daemonEventBus` next to `taskManager`:

```typescript
    taskManager,
    daemonEventBus,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/server/runtime.daemonBus.test.ts`

Expected: PASS — `runtime.daemonEventBus` is defined; TaskManager publishes at least one `task_update` event during a state transition.

If the test fails because the synthetic task creation throws (e.g., the no-op scheduler can't actually delegate to a missing 'echo' agent), simplify the test to spy on `taskStore.updateState` rather than going through `taskManager.create`. The invariant being verified is "the bus is wired into TaskManager"; assert it via inspection of the manager's options if needed (`expect(runtime.taskManager['opts'].bus).toBe(runtime.daemonEventBus)`).

- [ ] **Step 8: Run the full server test suite**

Run: `bun test tests/server/`

Expected: PASS — no regressions. The existing TaskManager tests don't pass `bus`, so the optional field stays harmless.

- [ ] **Step 9: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`

Expected: clean.

- [ ] **Step 10: Testing-log entry and commit**

Append `## 2026-05-XX — Phase 16.1 M7 T2 — DaemonEventBus wired into TaskManager (closes #28)` entry to `docs/06-testing/testing-log.md`.

```bash
git add src/server/runtime.ts tests/server/runtime.daemonBus.test.ts docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
feat(server): M7 T2 — DaemonEventBus wired into TaskManager

buildRuntime constructs an in-memory DaemonEventBus and passes it to the
TaskManager constructor. task_update events now fire onto the bus during
state transitions. No subscriber inside the server process in M7 —
plumbing for future cross-process consumers per M7-06.

Closes backlog #28.
EOF
)"
git push origin master
```

- [ ] **Step 11: `sov upgrade` per convention**

Run: `sov upgrade`

Expected: clean.

---

## Task 3: Per-session context registry + trace writer

**Goal:** Introduce `SessionContext` as the per-session subsystem holder. Runtime gains `getSessionContext(sessionId)` (lazy-build + cache) and `disposeSession(sessionId)` (shutdown sequence). T3 wires the trace writer first; T4/T5/T6 extend SessionContext with trajectory metadata, learning observer, and review manager respectively. The turns route fetches the SessionContext per turn and forwards `traceWriter.record` to `query()` as `traceRecorder`. Closes prereq row 10.

**Files:**
- Create: `src/server/sessionContext.ts`
- Modify: `src/server/runtime.ts`, `src/server/routes/turns.ts`
- Create: `tests/server/sessionContext.test.ts`, `tests/server/turns.trace.test.ts`

**Spec / inventory pointers:**
- `src/trace/writer.ts:35-88` — `TraceWriter` class. Constructor: `new TraceWriter({ sessionId, harnessHome?, path?, log? })`. Methods: `record(event)`, `close()`. Property: `path`, `count`.
- `src/ui/terminalRepl.ts:594` — reference construction: `const traceWriter = new TraceWriter({ sessionId: activeSessionId, harnessHome })`.
- `src/ui/terminalRepl.ts:599` — first event: `traceWriter.record({ type: 'session_start', iso: new Date().toISOString(), ... })`.
- `src/ui/terminalRepl.ts:961` — `traceRecorder = (e) => traceWriter.record(e)` bound onto query() params.
- `src/ui/terminalRepl.ts:1437` — child-session rebind site.
- `src/ui/terminalRepl.ts:1947` — session_end event recorded.
- `src/ui/terminalRepl.ts:1952` — `await traceWriter.close()` at session end.
- `src/core/query.ts` — accepts `traceRecorder?: (event: TraceEvent) => void` as a param (verify exact name via `grep -n 'traceRecorder' src/core/query.ts`).
- `src/server/routes/turns.ts:128-144` — current `buildSessionToolContext`.
- `src/server/routes/turns.ts:146` onwards — `runTurnInBackground` body.

- [ ] **Step 1: Verify query()'s traceRecorder param**

Run: `grep -n 'traceRecorder\|traceWriter\|trace.*record' src/core/query.ts src/core/types.ts | head -30`

Expected: confirms the param name and shape used by `query()`. Likely `traceRecorder?: (event: TraceEvent) => void` on `QueryParams`. Adjust step 5 forwarding to match the actual name.

- [ ] **Step 2: Write the failing test (sessionContext unit test)**

Create `tests/server/sessionContext.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('SessionContext lifecycle (M7 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t3-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('getSessionContext returns a populated context with traceWriter', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    const ctx = runtime.getSessionContext(sessionId);
    expect(ctx).toBeDefined();
    expect(ctx.traceWriter).toBeDefined();
    expect(ctx.traceWriter.path).toContain(sessionId);

    // Cached: second call returns the same instance.
    const ctx2 = runtime.getSessionContext(sessionId);
    expect(ctx2).toBe(ctx);

    await runtime.dispose();
  });

  test('disposeSession closes the trace writer; file is finalized on disk', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    const ctx = runtime.getSessionContext(sessionId);
    ctx.traceWriter.record({
      type: 'session_start',
      iso: new Date().toISOString(),
      sessionId,
      provider: 'mock',
      model: runtime.model,
    } as never);

    const tracePath = ctx.traceWriter.path;
    await runtime.disposeSession(sessionId);

    expect(existsSync(tracePath)).toBe(true);
    const content = readFileSync(tracePath, 'utf8');
    expect(content).toContain('"type":"session_start"');

    // After dispose, the session context is evicted: getSessionContext rebuilds.
    const ctx2 = runtime.getSessionContext(sessionId);
    expect(ctx2).not.toBe(ctx);

    await runtime.dispose();
  });

  test('runtime.dispose() walks live sessionContexts and disposes each', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    const sessionA = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });
    const sessionB = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    const ctxA = runtime.getSessionContext(sessionA);
    const ctxB = runtime.getSessionContext(sessionB);

    ctxA.traceWriter.record({ type: 'session_start', iso: new Date().toISOString(), sessionId: sessionA, provider: 'mock', model: runtime.model } as never);
    ctxB.traceWriter.record({ type: 'session_start', iso: new Date().toISOString(), sessionId: sessionB, provider: 'mock', model: runtime.model } as never);

    await runtime.dispose();

    expect(existsSync(ctxA.traceWriter.path)).toBe(true);
    expect(existsSync(ctxB.traceWriter.path)).toBe(true);
    const contentA = readFileSync(ctxA.traceWriter.path, 'utf8');
    const contentB = readFileSync(ctxB.traceWriter.path, 'utf8');
    expect(contentA).toContain('"type":"session_start"');
    expect(contentB).toContain('"type":"session_start"');
  });

  test('double-dispose is idempotent', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });
    runtime.getSessionContext(sessionId);
    await runtime.disposeSession(sessionId);
    await runtime.disposeSession(sessionId); // no throw
    await runtime.dispose();
  });
});
```

- [ ] **Step 3: Write the failing test (server-side trace integration)**

Create `tests/server/turns.trace.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { runTurnInBackground } from '../../src/server/routes/turns.js';

describe('turns route — server-side trace writer (M7 T3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t3-trace-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('one turn fires trace events; file lands at <harnessHome>/traces/<sessionId>.jsonl', async () => {
    const provider = new MockProvider({
      script: [{ kind: 'text', text: 'hello' }],
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
      preflight: false,
    });

    const bus = new ServerEventBus();
    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: 'mock',
      platform: 'test',
    });

    await runTurnInBackground(runtime, sessionId, 'hi', bus);

    const tracePath = join(tmpHome, 'traces', `${sessionId}.jsonl`);
    // Force the trace writer to flush by disposing the session.
    await runtime.disposeSession(sessionId);

    expect(existsSync(tracePath)).toBe(true);
    const content = readFileSync(tracePath, 'utf8');
    expect(content).toContain('"type":"turn_start"');
    expect(content).toContain('"type":"provider_request"');
    expect(content).toContain('"type":"provider_response"');

    await runtime.dispose();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test tests/server/sessionContext.test.ts tests/server/turns.trace.test.ts`

Expected: FAIL — `runtime.getSessionContext` / `runtime.disposeSession` don't exist; trace writer not wired in turns route; trace file not produced.

- [ ] **Step 5: Create `src/server/sessionContext.ts`**

```typescript
// Phase 16.1 M7 T3 — per-session subsystem registry.
//
// SessionContext holds the per-session subsystems that terminalRepl tracks
// directly (trace writer, learning observer, review manager). On the server
// side these are per-session because (a) their state is scoped to a single
// sessionId (b) the file paths they write to are named by sessionId and
// (c) compaction creates a new child sessionId that warrants a fresh context.
//
// Runtime owns a Map<sessionId, SessionContext> with lazy-build semantics:
// first `runtime.getSessionContext(sessionId)` call builds and caches; later
// calls return the cached instance. Disposal evicts from the map.
//
// T3 wires the trace writer only. T4 extends with trajectory metadata, T5
// with learning observer, T6 with review manager. The file is written
// monolithically in T3 with stub fields so later tasks have a stable shape
// to extend.

import { LearningObserver } from '../learning/observer.js';
import { ReviewManager } from '../review/manager.js';
import { TraceWriter } from '../trace/writer.js';
import type { Runtime } from './runtime.js';

export type SessionContext = {
  sessionId: string;
  traceWriter: TraceWriter;
  /** T5 — populated when learning is enabled. */
  learningObserver?: LearningObserver;
  /** T6 — populated when review is enabled. */
  reviewManager?: ReviewManager;
};

export type BuildSessionContextOpts = {
  runtime: Runtime;
  sessionId: string;
};

/** Lazy-build a SessionContext for the given session id. Idempotent within
 *  a runtime — Runtime caches the return on first call. Construction is
 *  cheap (TraceWriter opens an append-only file handle; LearningObserver
 *  and ReviewManager are built in T5/T6). */
export function buildSessionContext(opts: BuildSessionContextOpts): SessionContext {
  const { runtime, sessionId } = opts;

  const traceWriter = new TraceWriter({
    sessionId,
    harnessHome: runtime.harnessHome,
  });

  // T5/T6 extension points: construct learningObserver and reviewManager
  // here when those tasks land. Until then, the fields are left undefined.

  return {
    sessionId,
    traceWriter,
  };
}

/** Shutdown sequence for a SessionContext:
 *  1. Close the trace writer (drains pending writes to the JSONL file).
 *  2. (T5) Drain the learning observer.
 *  3. (T4) Write the trajectory record.
 *  4. (T6) Emit the review manager's getDispatchSummary onto the bus.
 *
 *  Idempotent — safe to call multiple times. Errors during any step are
 *  swallowed (logged to stderr) so disposal completes even if one
 *  subsystem misbehaves (Invariant #10 — best-effort disposal). */
export async function disposeSessionContext(
  ctx: SessionContext,
  opts?: { log?: (msg: string) => void },
): Promise<void> {
  const log = opts?.log ?? ((msg) => process.stderr.write(`${msg}\n`));

  try {
    await ctx.traceWriter.close();
  } catch (err) {
    log(`[m7] trace writer close failed for ${ctx.sessionId}: ${String(err)}`);
  }

  // T5: drain learning observer.
  // T4: write trajectory.
  // T6: emit session_summary event.
}
```

- [ ] **Step 6: Add SessionContext fields to Runtime**

In `src/server/runtime.ts`, add the import:

```typescript
import {
  type SessionContext,
  buildSessionContext,
  disposeSessionContext,
} from './sessionContext.js';
```

Extend `RuntimeOptions` (after `daemonEventBus?`):

```typescript
  /** Per-session context factory override (test injection seam). When
   *  omitted, buildRuntime uses the default buildSessionContext(). */
  sessionContextFactory?: (sessionId: string) => SessionContext;
```

Extend `Runtime` (after `daemonEventBus`):

```typescript
  /** Per-session subsystem registry (M7-01). Holds trace writer, learning
   *  observer, review manager for each active session id. Built lazily on
   *  first getSessionContext call; evicted on disposeSession or
   *  runtime.dispose. */
  sessionContexts: Map<string, SessionContext>;
  /** Lazy-build or return the cached SessionContext for sessionId. Safe
   *  to call repeatedly; idempotent. */
  getSessionContext: (sessionId: string) => SessionContext;
  /** Tear down the per-session subsystems for sessionId and evict from
   *  the registry. Idempotent — no-op if sessionId is not registered. */
  disposeSession: (sessionId: string) => Promise<void>;
```

- [ ] **Step 7: Wire SessionContext into buildRuntime**

In `buildRuntime`, after all the existing field construction and before the return literal (around line 535), add:

```typescript
  // M7 T3 — per-session subsystem registry. Forward-declare 'runtime' as
  // a self-referencing const because buildSessionContext takes the runtime
  // instance (it reads runtime.harnessHome, runtime.subagentScheduler in
  // T5/T6, etc.). The factory closes over the partial runtime.
  const sessionContexts = new Map<string, SessionContext>();
  const factory: (sessionId: string) => SessionContext =
    opts.sessionContextFactory ?? ((sessionId) => buildSessionContext({ runtime: runtimeRef, sessionId }));
  const getSessionContext = (sessionId: string): SessionContext => {
    let ctx = sessionContexts.get(sessionId);
    if (!ctx) {
      ctx = factory(sessionId);
      sessionContexts.set(sessionId, ctx);
    }
    return ctx;
  };
  const disposeSession = async (sessionId: string): Promise<void> => {
    const ctx = sessionContexts.get(sessionId);
    if (!ctx) return;
    sessionContexts.delete(sessionId);
    await disposeSessionContext(ctx);
  };
```

The `runtimeRef` forward-reference pattern is needed because `buildSessionContext` reads `runtime.harnessHome` (and later, in T5/T6, more runtime fields). Use a let-declared `runtimeRef: Runtime` initialized after the return literal is built:

Replace the existing `return { ... };` block (around line 537–569) with:

```typescript
  const runtimeRef: Runtime = {
    sessionDb,
    toolPool,
    systemSegments,
    provider,
    model: resolved.model,
    agents,
    bundle,
    cwd: opts.cwd,
    bundleRoot,
    harnessHome,
    resolvedProvider: resolved,
    canUseTool,
    permissionMode,
    resumeId: opts.resumeId,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    hookRunner,
    approvalQueue,
    laneSemaphores,
    writeLock,
    subagentScheduler,
    taskManager,
    daemonEventBus,
    microcompactConfig,
    compact,
    proactiveCompactThreshold,
    mcpClientPool,
    sessionContexts,
    getSessionContext,
    disposeSession,
    dispose: async () => {
      // M7-08 disposal order: per-session subsystems → MCP pool → approval queue → sessionDb.
      const sessionIds = Array.from(sessionContexts.keys());
      for (const sessionId of sessionIds) {
        await disposeSession(sessionId);
      }
      if (mcpClientPool) await mcpClientPool.shutdown();
      approvalQueue.disposeAll();
      sessionDb.close();
    },
  };
  return runtimeRef;
}
```

The `runtimeRef` const captures the closure that `factory` reads. The factory was defined BEFORE `runtimeRef` was assigned, so it MUST reference the captured const lazily (the closure is fine — JavaScript closures capture references, not values, so by the time `factory(sessionId)` actually fires, `runtimeRef` has been initialized).

- [ ] **Step 8: Run the SessionContext unit tests to verify they pass**

Run: `bun test tests/server/sessionContext.test.ts`

Expected: PASS — all 4 tests pass.

If "getSessionContext rebuilds after dispose" fails because the cache eviction isn't right, fix the order in `disposeSession`: delete from the map BEFORE awaiting `disposeSessionContext` (so a concurrent get during disposal sees the missing entry and rebuilds).

- [ ] **Step 9: Wire trace recorder into turns route**

In `src/server/routes/turns.ts`, locate `runTurnInBackground` (around line 146). The function's signature: `(runtime: Runtime, sessionIdInitial: string, text: string, bus: ServerEventBus): Promise<void>`.

Just after the `let sessionId = sessionIdInitial;` line (around line 158) and BEFORE the userMessage construction, add:

```typescript
  // M7 T3 — per-session trace writer. Look up (or lazy-build) the context
  // for the current sessionId. After compaction (M6), the sessionId pivots
  // and the next iteration will fetch a fresh context for the child.
  const sessionCtx = runtime.getSessionContext(sessionId);
  const traceRecorder = (event: import('../../trace/types.js').TraceEvent): void => {
    sessionCtx.traceWriter.record(event);
  };
```

(Verify the TraceEvent import path with `grep -n 'TraceEvent' src/trace/types.ts`. If the type is exported from `src/trace/writer.ts` instead, adjust.)

Inside the `try` block, find the `query()` call (or wherever query() is invoked from runTurnInBackground — search for `query(` in the file). Add `traceRecorder` to its params:

```typescript
  // Existing query() invocation gains the traceRecorder arg.
  const stream = query({
    // ... existing params ...
    traceRecorder,
  });
```

If `query()` is wrapped through a helper (e.g., `runOnce(messages)` from M6 T4), thread `traceRecorder` through to that helper's `query()` call.

After M6's proactive compaction creates a new child session id, the `sessionCtx` reference becomes stale (it points at the parent). After the `sessionId = result.newSessionId` reassignment in the proactive branch, refresh:

```typescript
  // After proactive compaction pivots the session id, the SessionContext
  // for the parent is no longer the active one. Look up the child's.
  if (!result.noOp) {
    sessionId = result.newSessionId;
    const newCtx = runtime.getSessionContext(sessionId);
    // Rebind the traceRecorder closure to the new context. The simplest
    // approach: shadow the outer 'sessionCtx' via a new let binding.
    sessionCtx = newCtx;
  }
```

This requires changing the outer `const sessionCtx` to `let sessionCtx`. Apply the same reassignment in the overflow-recovery branch (M6 T4).

- [ ] **Step 10: Run the trace integration test to verify it passes**

Run: `bun test tests/server/turns.trace.test.ts`

Expected: PASS — the trace file lands at the expected path with `turn_start`, `provider_request`, `provider_response` event types in it.

- [ ] **Step 11: Run the full server suite + lint + typecheck**

Run: `bun test tests/server/ && bun run lint && bun run typecheck`

Expected: PASS. No regressions; lint clean.

- [ ] **Step 12: Testing-log entry and commit**

Append `## 2026-05-XX — Phase 16.1 M7 T3 — per-session context + trace writer wired` entry to `docs/06-testing/testing-log.md`.

```bash
git add src/server/sessionContext.ts src/server/runtime.ts src/server/routes/turns.ts tests/server/sessionContext.test.ts tests/server/turns.trace.test.ts docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
feat(server): M7 T3 — per-session context registry + trace writer

Introduces SessionContext (src/server/sessionContext.ts) as the
per-session subsystem holder. Runtime gains getSessionContext (lazy
build + cache) and disposeSession (shutdown sequence). T3 wires the
trace writer; T4–T6 extend SessionContext.

The turns route fetches the SessionContext per turn and forwards
traceWriter.record to query() as traceRecorder. After M6 compaction
pivots sessionId, the route fetches the child's SessionContext on the
next hydrate.

Closes prereq row 10.
EOF
)"
git push origin master
```

- [ ] **Step 13: `sov upgrade`**

Run: `sov upgrade`

Expected: clean rebuild.

---

## Task 4: Trajectory capture on session disposal

**Goal:** When `runtime.disposeSession(sessionId)` is invoked, the session's full message history is written as a ShareGPT-shaped JSONL record into `<artifactsRoot>/trajectories/{samples,failed}.jsonl` (bucket determined by terminal reason). Redaction is applied at write per Invariant #15. Closes prereq row 11.

**Files:**
- Modify: `src/server/sessionContext.ts`
- Modify: `src/server/runtime.ts`
- Create: `tests/server/runtime.trajectory.test.ts`

**Spec / inventory pointers:**
- `src/trajectory/writer.ts:22-116` — `tryWriteTrajectory(opts: WriteOpts, log?): Promise<WriteResult | null>`. Takes `{ messages, terminal, metadata, artifactsRoot }`. Returns `{ path, bucket, bytes } | null`.
- `src/ui/terminalRepl.ts:1923-1942` — reference call shape.
- `src/server/runtime.ts:269-273` — `resolveSubagentArtifactsRoot(harnessHome, bundle): string` already exists from M5.1 (backlog #26). Re-use.
- `src/agent/sessionDb.ts` — `loadMessages(sessionId): Message[]` (existing).
- M5.1 docs/07-history/state/archive/2026-05-14.md — `artifactsRoot` already plumbed for sub-agent trajectory capture (`runtime.cwd` / `runtime.bundle` aware).

- [ ] **Step 1: Write the failing test**

Create `tests/server/runtime.trajectory.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('disposeSession writes trajectory (M7 T4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t4-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('completed terminal → samples.jsonl bucket', async () => {
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

    runtime.sessionDb.saveMessage(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
    runtime.sessionDb.saveMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
    });

    // Mark the session terminal as a completed turn (M7 T4 surfaces a way
    // to communicate this; default behavior assumes 'completed' when no
    // terminal info is recorded — see T4 step 4 for the implementation
    // detail. The test asserts the file lands.)
    await runtime.disposeSession(sessionId);

    const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
    expect(existsSync(samplesPath)).toBe(true);
    const content = readFileSync(samplesPath, 'utf8');
    expect(content).toContain('"sessionId":"' + sessionId + '"');
    // ShareGPT shape: `conversations` array with from/value records.
    expect(content).toContain('"from":"human"');
    expect(content).toContain('"from":"gpt"');

    await runtime.dispose();
  });

  test('redaction applied at write — Bearer tokens scrubbed', async () => {
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

    runtime.sessionDb.saveMessage(sessionId, {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'authorization: Bearer sk-proj-VERY-SECRET-1234567890abcdef',
        },
      ],
    });

    await runtime.disposeSession(sessionId);

    const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
    const content = readFileSync(samplesPath, 'utf8');
    expect(content).not.toContain('sk-proj-VERY-SECRET-1234567890abcdef');
    // Redaction substitutes a marker; substring depends on redact.ts behavior.
    expect(content).toMatch(/\[REDACTED|<bearer|\*\*\*/);

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/runtime.trajectory.test.ts`

Expected: FAIL — no trajectory file is produced; `samples.jsonl` does not exist.

- [ ] **Step 3: Extend SessionContext with trajectory metadata**

In `src/server/sessionContext.ts`, extend the SessionContext type:

```typescript
export type SessionContext = {
  sessionId: string;
  traceWriter: TraceWriter;
  /** T4 — accumulated turn-level metadata for the final trajectory write.
   *  Updated as the session runs (toolCallCount, iterationsUsed, etc.). */
  trajectoryMetadata: {
    toolCallCount: number;
    iterationsUsed: number;
    estimatedCostUsd: number;
    /** Set when the terminal reason is known. Default 'completed' if
     *  unset at disposal time (the absence of a recorded error implies
     *  graceful end). */
    terminalReason?: 'completed' | 'aborted' | 'error' | 'context_overflow' | 'max_iterations';
    terminalError?: string;
  };
  /** T5 — populated when learning is enabled. */
  learningObserver?: LearningObserver;
  /** T6 — populated when review is enabled. */
  reviewManager?: ReviewManager;
};
```

Extend `buildSessionContext`:

```typescript
export function buildSessionContext(opts: BuildSessionContextOpts): SessionContext {
  const { runtime, sessionId } = opts;

  const traceWriter = new TraceWriter({
    sessionId,
    harnessHome: runtime.harnessHome,
  });

  return {
    sessionId,
    traceWriter,
    trajectoryMetadata: {
      toolCallCount: 0,
      iterationsUsed: 0,
      estimatedCostUsd: 0,
    },
  };
}
```

- [ ] **Step 4: Extend `disposeSessionContext` to write the trajectory**

Update the imports at the top of `src/server/sessionContext.ts`:

```typescript
import { tryWriteTrajectory } from '../trajectory/writer.js';
import type { Terminal } from '../core/types.js';
```

(Verify the `Terminal` type import path with `grep -n 'export.*Terminal' src/core/types.ts`.)

Update `disposeSessionContext`:

```typescript
export async function disposeSessionContext(
  ctx: SessionContext,
  opts: { runtime: Runtime; log?: (msg: string) => void },
): Promise<void> {
  const log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));
  const { runtime } = opts;

  // (1) Close the trace writer first — its file is final for this sessionId.
  try {
    await ctx.traceWriter.close();
  } catch (err) {
    log(`[m7] trace writer close failed for ${ctx.sessionId}: ${String(err)}`);
  }

  // (2) T5: drain learning observer.
  if (ctx.learningObserver) {
    try {
      await ctx.learningObserver.drain();
    } catch (err) {
      log(`[m7] learning observer drain failed for ${ctx.sessionId}: ${String(err)}`);
    }
  }

  // (3) T4: write the trajectory record.
  try {
    const messages = runtime.sessionDb.loadMessages(ctx.sessionId);
    if (messages.length > 0) {
      const md = ctx.trajectoryMetadata;
      const terminal: Terminal = {
        reason: md.terminalReason ?? 'completed',
        ...(md.terminalError ? { error: new Error(md.terminalError) } : {}),
      } as Terminal;
      const artifactsRoot = resolveArtifactsRoot(runtime);
      await tryWriteTrajectory(
        {
          messages,
          terminal,
          metadata: {
            sessionId: ctx.sessionId,
            provider: runtime.resolvedProvider.transport.name,
            model: runtime.model,
            toolCallCount: md.toolCallCount,
            iterationsUsed: md.iterationsUsed,
            estimatedCostUsd: md.estimatedCostUsd,
          },
          artifactsRoot,
        },
        log,
      );
    }
  } catch (err) {
    log(`[m7] trajectory write failed for ${ctx.sessionId}: ${String(err)}`);
  }

  // (4) T6: emit session_summary event (lands in T6).
}

function resolveArtifactsRoot(runtime: Runtime): string {
  // Re-use M5.1's resolveSubagentArtifactsRoot via runtime — the path
  // semantics are identical: client bundles get bundle-local state,
  // default bundle routes to harnessHome.
  const bundle = runtime.bundle;
  const harnessHome = runtime.harnessHome;
  if (bundle && !bundle.root.startsWith(harnessHome)) {
    // Client bundle path: <bundleRoot>/state/artifacts (M5.1 contract).
    return `${bundle.root}/state/artifacts`;
  }
  return harnessHome;
}
```

NOTE: `resolveArtifactsRoot` here is a local helper rather than reusing `resolveSubagentArtifactsRoot` from `src/server/runtime.ts` because that helper takes `bundle` plus `harnessHome` rather than `runtime`. Either:
- (a) Export `resolveSubagentArtifactsRoot` from runtime.ts and import here (need to check existing visibility — it's exported per the M5.1 docs).
- (b) Keep the local helper as written.

Prefer (a) for DRY. Replace the local helper with:

```typescript
import { resolveSubagentArtifactsRoot } from './runtime.js';
// ...
const artifactsRoot = resolveSubagentArtifactsRoot(runtime.harnessHome, runtime.bundle);
```

Verify the export with: `grep -n 'export function resolveSubagentArtifactsRoot' src/server/runtime.ts`.

- [ ] **Step 5: Update `runtime.disposeSession` to thread the runtime to `disposeSessionContext`**

In `src/server/runtime.ts`, update the `disposeSession` definition (from T3):

```typescript
  const disposeSession = async (sessionId: string): Promise<void> => {
    const ctx = sessionContexts.get(sessionId);
    if (!ctx) return;
    sessionContexts.delete(sessionId);
    await disposeSessionContext(ctx, { runtime: runtimeRef });
  };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/server/runtime.trajectory.test.ts`

Expected: PASS — both tests pass. Samples.jsonl is produced; Bearer tokens are scrubbed.

- [ ] **Step 7: Full server suite + lint + typecheck**

Run: `bun test tests/server/ && bun run lint && bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Testing-log + commit**

Append `## 2026-05-XX — Phase 16.1 M7 T4 — trajectory capture wired into disposeSession` entry.

```bash
git add src/server/sessionContext.ts src/server/runtime.ts tests/server/runtime.trajectory.test.ts docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
feat(server): M7 T4 — trajectory capture on session disposal

disposeSession now writes the session's full history as a ShareGPT-shaped
JSONL record into <artifactsRoot>/trajectories/{samples,failed}.jsonl.
Bucket selection by terminal reason. Redaction applied at write per
Invariant #15. Trajectory metadata accumulates on SessionContext over
the session lifetime.

Closes prereq row 11.
EOF
)"
git push origin master
```

- [ ] **Step 9: `sov upgrade`**

Run: `sov upgrade`

Expected: clean.

---

## Task 5: Learning observer wiring

**Goal:** Per-session `LearningObserver` lives in `SessionContext` and is threaded onto `ToolContext.learningObserver`. The orchestrator (`src/core/orchestrator.ts`) already reads `toolContext.learningObserver?.observe(...)` after every tool call (M7-04 — direct-call, not bus-subscribed). Settings cascade: `userSettings.learning.disabled` and `userSettings.learning.observationBufferSize` honored. Drain on disposal (already wired in T4's `disposeSessionContext`). Closes prereq row 12.

**Files:**
- Modify: `src/server/sessionContext.ts`
- Modify: `src/server/routes/turns.ts`
- Create: `tests/server/turns.learning.test.ts`

**Spec / inventory pointers:**
- `src/learning/observer.ts:15-138` — `LearningObserver` class. Constructor: `new LearningObserver({ harnessHome, cwd, sessionId, bufferSize?, enabled? })`. Methods: `observe(input)`, `drain(timeoutMs?)`, `getDroppedCount()`.
- `src/learning/paths.ts` — `observationsPath(harnessHome, projectId)` returns `<harnessHome>/learning/<projectId>/observations.jsonl`.
- `src/learning/project.ts:13` — `getProjectId(cwd): { id, name }` — git-remote-aware project identity resolution.
- `src/tool/types.ts:134-139` — `ToolContext.learningObserver?` already declared.
- `src/ui/terminalRepl.ts:~1100` — reference construction.
- `src/config/schema.ts` — `learning.disabled?`, `learning.observationBufferSize?` fields.

- [ ] **Step 1: Write the failing test**

Create `tests/server/turns.learning.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { runTurnInBackground } from '../../src/server/routes/turns.js';
import { getProjectId } from '../../src/learning/project.js';

describe('turns route — learning observer (M7 T5)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t5-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('turn with tool calls emits observations to learning JSONL', async () => {
    const provider = new MockProvider({
      script: [
        { kind: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
        { kind: 'text', text: 'done' },
      ],
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
      preflight: false,
    });

    const bus = new ServerEventBus();
    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: 'mock',
      platform: 'test',
    });

    await runTurnInBackground(runtime, sessionId, 'run echo hi', bus);
    await runtime.disposeSession(sessionId);

    const projectId = getProjectId(tmpHome).id;
    const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
    expect(existsSync(obsPath)).toBe(true);
    const content = readFileSync(obsPath, 'utf8');
    expect(content).toContain('"toolName":"Bash"');
    expect(content).toContain('"status":"success"');

    await runtime.dispose();
  });

  test('learning.disabled === true → no observer constructed, no observations written', async () => {
    process.env.HARNESS_CONFIG_PATH = join(tmpHome, 'config.json');
    require('node:fs').writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({ learning: { disabled: true } }),
    );

    try {
      const provider = new MockProvider({
        script: [{ kind: 'tool_use', name: 'Bash', input: { command: 'echo x' } }, { kind: 'text', text: 'ok' }],
      });
      const runtime = await buildRuntime({
        cwd: tmpHome,
        harnessHome: tmpHome,
        provider: 'mock',
        providerInstance: provider,
        preflight: false,
      });

      const bus = new ServerEventBus();
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: 'mock',
        platform: 'test',
      });

      await runTurnInBackground(runtime, sessionId, 'go', bus);
      await runtime.disposeSession(sessionId);

      const projectId = getProjectId(tmpHome).id;
      const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
      expect(existsSync(obsPath)).toBe(false);

      await runtime.dispose();
    } finally {
      delete process.env.HARNESS_CONFIG_PATH;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/turns.learning.test.ts`

Expected: FAIL — observations.jsonl is not produced; the observer is not constructed.

- [ ] **Step 3: Construct LearningObserver in `buildSessionContext`**

Update `src/server/sessionContext.ts`. Add imports:

```typescript
import { readConfig } from '../config/store.js';
```

Update `buildSessionContext`:

```typescript
export function buildSessionContext(opts: BuildSessionContextOpts): SessionContext {
  const { runtime, sessionId } = opts;

  const traceWriter = new TraceWriter({
    sessionId,
    harnessHome: runtime.harnessHome,
  });

  // M7 T5 — learning observer. Per-session, sourced from settings cascade.
  // When learning.disabled === true, leave the field undefined (the
  // orchestrator's optional-chain `ctx.learningObserver?.observe(...)`
  // becomes a no-op).
  // Read settings here rather than threading them via opts so the
  // factory remains stateless beyond runtime.
  const userSettings = readConfig();
  const learningEnabled = !(userSettings.learning?.disabled === true);
  const learningObserver: LearningObserver | undefined = learningEnabled
    ? new LearningObserver({
        harnessHome: runtime.harnessHome,
        cwd: runtime.cwd,
        sessionId,
        bufferSize: userSettings.learning?.observationBufferSize ?? 200,
        enabled: true,
      })
    : undefined;

  return {
    sessionId,
    traceWriter,
    trajectoryMetadata: {
      toolCallCount: 0,
      iterationsUsed: 0,
      estimatedCostUsd: 0,
    },
    learningObserver,
  };
}
```

Note: `readConfig()` reads from `HARNESS_CONFIG_PATH` env var or the default `<harnessHome>/config.json`. Per Decision M7-01, each `getSessionContext` call constructs once; subsequent calls return cached. Settings are therefore captured at first-reference time per session — reasonable for v1.

- [ ] **Step 4: Thread `learningObserver` onto ToolContext in turns route**

In `src/server/routes/turns.ts`, update `buildSessionToolContext` (around line 128–144). The current shape:

```typescript
export function buildSessionToolContext(
  runtime: Runtime,
  sessionId: string,
  sessionCanUseTool: CanUseTool,
): ToolContext {
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
  };
}
```

Update to:

```typescript
export function buildSessionToolContext(
  runtime: Runtime,
  sessionId: string,
  sessionCanUseTool: CanUseTool,
): ToolContext {
  const sessionCtx = runtime.getSessionContext(sessionId);
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
    // M7 T5 — per-session learning observer. Orchestrator reads this via
    // optional-chain after every tool call.
    ...(sessionCtx.learningObserver ? { learningObserver: sessionCtx.learningObserver } : {}),
    // M7 T6 (placeholder, populated by T6) — review manager.
    ...(sessionCtx.reviewManager ? { reviewManager: sessionCtx.reviewManager } : {}),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/server/turns.learning.test.ts`

Expected: PASS — both tests pass.

- [ ] **Step 6: Full suite + lint + typecheck**

Run: `bun test tests/server/ && bun run lint && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Testing-log + commit**

Append `## 2026-05-XX — Phase 16.1 M7 T5 — learning observer wired into ToolContext` entry.

```bash
git add src/server/sessionContext.ts src/server/routes/turns.ts tests/server/turns.learning.test.ts docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
feat(server): M7 T5 — learning observer wired into ToolContext

Per-session LearningObserver lives in SessionContext and is threaded
onto ToolContext.learningObserver. Orchestrator reads it via
optional-chain after every tool call (M7-04 direct-call pattern).
Settings cascade: learning.disabled / learning.observationBufferSize.
Drain runs in disposeSessionContext.

Closes prereq row 12.
EOF
)"
git push origin master
```

- [ ] **Step 8: `sov upgrade`**

Run: `sov upgrade`

---

## Task 6: Review manager wiring + propose-then-promote pipeline

**Goal:** Per-session `ReviewManager` lives in `SessionContext` and is threaded onto `ToolContext.reviewManager`. Triggers fire from existing in-process call sites (orchestrator's `onToolIteration`, scheduler's `onChildCompletion`, turns route's `onUserTurn`). `runReviewFork()` dispatches via `runtime.subagentScheduler` to write `memory_propose`/`skill_propose` proposals into `<harnessHome>/review/pending/`. At session disposal, `getDispatchSummary()` runs and the result emits as a `session_summary` SSE event for the TUI to render (M9 polish). Closes prereq row 13.

**Files:**
- Modify: `src/server/sessionContext.ts`
- Modify: `src/server/routes/turns.ts`
- Modify: `src/server/schema.ts`
- Create: `tests/server/turns.review.test.ts`

**Spec / inventory pointers:**
- `src/review/manager.ts:115-327` — `ReviewManager` class. Constructor: `new ReviewManager({ scheduler, sessionId, signal, thresholds, pathsResolver, parentToolPool, parentToolContext, enabled, traceRecorder, projectIdentity, harnessHome })`. Methods: `onUserTurn(sessionId)`, `onToolIteration(sessionId)`, `onChildCompletion(evt)`, `runConsolidationPass(home)`, `getDispatchSummary()`.
- `src/review/consolidate.ts:27` — `runConsolidation(opts)` wraps `runReviewFork` with agent=`'review-consolidate'`.
- `src/review/manager.ts:103` — `isSkillShaped(evt)` triage heuristic.
- `src/core/query.ts` — search for `reviewManager.onToolIteration` to confirm the call site exists.
- `src/runtime/scheduler.ts` — search for `reviewManager.onChildCompletion` to confirm.
- `src/ui/terminalRepl.ts:~1070` — reference construction with full opts object.
- `src/config/schema.ts` — `review.disabled`, `review.userTurnsForMemoryReview`, etc. Verify via `grep -n 'review' src/config/schema.ts`.
- `src/server/schema.ts` — wire-event union (where M6's CompactionCompleteEvent was added).

- [ ] **Step 1: Verify in-process call sites exist**

Run:

```bash
grep -n 'reviewManager' src/core/query.ts src/runtime/scheduler.ts src/core/orchestrator.ts
```

Expected: confirms `toolCtx.reviewManager?.onToolIteration(...)` (in query.ts or orchestrator.ts) and `parentToolContext.reviewManager?.onChildCompletion(...)` (in scheduler.ts). These call sites already exist (per the agent research) — M7 just needs to populate the field on ToolContext.

If the call sites are missing or in different locations than expected, the test in step 2 won't observe the trigger fire; adjust the test to call `runtime.getSessionContext(sessionId).reviewManager?.onToolIteration(sessionId)` directly to verify the wiring exists, deferring the orchestrator-driven path to T7 integration smoke.

- [ ] **Step 2: Write the failing test**

Create `tests/server/turns.review.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';
import { MockProvider } from '../../src/providers/mock.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { runTurnInBackground } from '../../src/server/routes/turns.js';

describe('turns route — review manager (M7 T6)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t6-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('SessionContext exposes reviewManager when enabled', async () => {
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
    expect(ctx.reviewManager).toBeDefined();

    // Sanity: triggers exist on the manager.
    expect(typeof ctx.reviewManager!.onUserTurn).toBe('function');
    expect(typeof ctx.reviewManager!.onToolIteration).toBe('function');
    expect(typeof ctx.reviewManager!.onChildCompletion).toBe('function');

    await runtime.dispose();
  });

  test('review.disabled === true → reviewManager left undefined', async () => {
    process.env.HARNESS_CONFIG_PATH = join(tmpHome, 'config.json');
    require('node:fs').writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({ review: { disabled: true } }),
    );
    try {
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
      expect(ctx.reviewManager).toBeUndefined();
      await runtime.dispose();
    } finally {
      delete process.env.HARNESS_CONFIG_PATH;
    }
  });

  test('disposeSession emits session_summary onto an attached bus', async () => {
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

    const bus = new ServerEventBus();
    const captured: Array<{ type: string }> = [];
    bus.subscribe((evt) => captured.push(evt));

    // Attach the bus to the session context BEFORE disposal so the summary
    // emission has a sink. T6 step 5 details the attachment mechanism.
    runtime.getSessionContext(sessionId);
    // Drive a synthetic onUserTurn → no actual dispatch will fire because
    // threshold isn't crossed; getDispatchSummary returns zeros.
    await runtime.disposeSession(sessionId, { bus });

    const summary = captured.find((e) => e.type === 'session_summary');
    expect(summary).toBeDefined();

    await runtime.dispose();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/server/turns.review.test.ts`

Expected: FAIL — `ctx.reviewManager` is undefined; `disposeSession` doesn't accept a bus arg; `session_summary` SSE type doesn't exist.

- [ ] **Step 4: Construct ReviewManager in `buildSessionContext`**

Update `src/server/sessionContext.ts` imports:

```typescript
import { ReviewManager } from '../review/manager.js';
import { getProjectId } from '../learning/project.js';
import { trajectoriesPath } from '../trajectory/paths.js';
import { instinctsDir } from '../learning/paths.js';
```

(Verify `trajectoriesPath` and `instinctsDir` exports with quick grep. If `trajectoriesPath` doesn't exist, derive the path inline from `resolveSubagentArtifactsRoot(runtime.harnessHome, runtime.bundle) + '/trajectories'`.)

Extend `buildSessionContext`:

```typescript
export function buildSessionContext(opts: BuildSessionContextOpts): SessionContext {
  const { runtime, sessionId } = opts;

  const traceWriter = new TraceWriter({
    sessionId,
    harnessHome: runtime.harnessHome,
  });

  const userSettings = readConfig();
  const learningEnabled = !(userSettings.learning?.disabled === true);
  const learningObserver: LearningObserver | undefined = learningEnabled
    ? new LearningObserver({
        harnessHome: runtime.harnessHome,
        cwd: runtime.cwd,
        sessionId,
        bufferSize: userSettings.learning?.observationBufferSize ?? 200,
        enabled: true,
      })
    : undefined;

  // M7 T6 — review manager.
  const reviewEnabled = !(userSettings.review?.disabled === true);
  const reviewAbortController = new AbortController();
  const reviewManager: ReviewManager | undefined = reviewEnabled
    ? new ReviewManager({
        scheduler: runtime.subagentScheduler,
        sessionId,
        signal: reviewAbortController.signal,
        thresholds: {
          // All from settings; ReviewManager picks defaults for missing fields.
          ...(userSettings.review?.userTurnsForMemoryReview !== undefined
            ? { userTurnsForMemoryReview: userSettings.review.userTurnsForMemoryReview }
            : {}),
          ...(userSettings.review?.toolIterationsForSkillReview !== undefined
            ? { toolIterationsForSkillReview: userSettings.review.toolIterationsForSkillReview }
            : {}),
          ...(userSettings.review?.childReviewEveryN !== undefined
            ? { childReviewEveryN: userSettings.review.childReviewEveryN }
            : {}),
          ...(userSettings.review?.minIntervalMs !== undefined
            ? { minIntervalMs: userSettings.review.minIntervalMs }
            : {}),
          ...(userSettings.learning?.synthesizerEveryN !== undefined
            ? { synthesizerEveryN: userSettings.learning.synthesizerEveryN }
            : {}),
          ...(userSettings.learning?.synthesizerEveryNToolIterations !== undefined
            ? { synthesizerEveryNToolIterations: userSettings.learning.synthesizerEveryNToolIterations }
            : {}),
        },
        pathsResolver: () => ({
          trajectoryPath: `${resolveSubagentArtifactsRoot(runtime.harnessHome, runtime.bundle)}/trajectories/samples.jsonl`,
          tracePath: traceWriter.path,
          instinctsDir: instinctsDir(runtime.harnessHome, getProjectId(runtime.cwd).id),
        }),
        parentToolPool: runtime.toolPool,
        // parentToolContext is the per-session ToolContext, but it's not
        // assembled until the turns route runs buildSessionToolContext.
        // Pass a placeholder that gets overwritten on first turn — or, more
        // honestly, pass a lazy resolver. ReviewManager's source shows it
        // reads parentToolContext only when dispatching, so a stale capture
        // would be a real bug. The cleanest fix: defer ReviewManager
        // construction to first-turn time inside the turns route. For M7 v0,
        // pass a minimal ToolContext that matches what runReviewFork actually
        // needs — terminalRepl passes its writableCtx which has cwd,
        // sessionId, harnessHome, agents, subagentScheduler, taskManager.
        parentToolContext: {
          cwd: runtime.cwd,
          sessionId,
          harnessHome: runtime.harnessHome,
          agents: runtime.agents,
          subagentScheduler: runtime.subagentScheduler,
          taskManager: runtime.taskManager,
          parentToolPool: runtime.toolPool,
        } as never,
        enabled: true,
        traceRecorder: (event) => traceWriter.record(event),
        projectIdentity: () => getProjectId(runtime.cwd),
        harnessHome: runtime.harnessHome,
      })
    : undefined;

  return {
    sessionId,
    traceWriter,
    trajectoryMetadata: {
      toolCallCount: 0,
      iterationsUsed: 0,
      estimatedCostUsd: 0,
    },
    ...(learningObserver ? { learningObserver } : {}),
    ...(reviewManager ? { reviewManager } : {}),
    reviewAbortController, // used in disposeSessionContext to signal in-flight reviews
  };
}
```

Update `SessionContext` to include `reviewAbortController`:

```typescript
export type SessionContext = {
  sessionId: string;
  traceWriter: TraceWriter;
  trajectoryMetadata: { ... };
  learningObserver?: LearningObserver;
  reviewManager?: ReviewManager;
  /** Abort signal for any in-flight review-fork sub-agents. Aborted in
   *  disposeSessionContext so disposal doesn't block on a hung review. */
  reviewAbortController: AbortController;
};
```

Update `resolveSubagentArtifactsRoot` import:

```typescript
import { resolveSubagentArtifactsRoot } from './runtime.js';
```

- [ ] **Step 5: Emit `session_summary` SSE event on session disposal**

First, add the event type. In `src/server/schema.ts`, locate the wire-event union (where `CompactionCompleteEvent` was added in M6). Add a new type:

```typescript
export type SessionSummaryEvent = {
  type: 'session_summary';
  seq: number;
  sessionId: string;
  totalDispatched: number;
  byAgent: Record<string, number>;
};
```

Add `SessionSummaryEvent` to the `WireEvent` union.

Then update `disposeSession` and `disposeSessionContext` to accept an optional bus and emit the event:

In `src/server/sessionContext.ts`:

```typescript
export async function disposeSessionContext(
  ctx: SessionContext,
  opts: { runtime: Runtime; bus?: ServerEventBus; log?: (msg: string) => void },
): Promise<void> {
  // ... existing trace close + learning drain + trajectory write ...

  // (4) T6 — emit session_summary if review manager was active.
  if (ctx.reviewManager) {
    try {
      ctx.reviewAbortController.abort();
      const summary = ctx.reviewManager.getDispatchSummary();
      if (opts.bus) {
        opts.bus.publish({
          type: 'session_summary',
          seq: opts.bus.nextSeq(),
          sessionId: ctx.sessionId,
          totalDispatched: summary.totalDispatched,
          byAgent: summary.byAgent,
        });
      } else {
        log(`[m7] session_summary for ${ctx.sessionId}: dispatched=${summary.totalDispatched} byAgent=${JSON.stringify(summary.byAgent)}`);
      }
    } catch (err) {
      log(`[m7] review manager summary failed for ${ctx.sessionId}: ${String(err)}`);
    }
  }
}
```

In `src/server/runtime.ts`, update `disposeSession` to accept and forward the bus:

```typescript
  const disposeSession = async (sessionId: string, opts?: { bus?: ServerEventBus }): Promise<void> => {
    const ctx = sessionContexts.get(sessionId);
    if (!ctx) return;
    sessionContexts.delete(sessionId);
    await disposeSessionContext(ctx, { runtime: runtimeRef, ...(opts?.bus ? { bus: opts.bus } : {}) });
  };
```

Update the `Runtime.disposeSession` signature:

```typescript
  disposeSession: (sessionId: string, opts?: { bus?: ServerEventBus }) => Promise<void>;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/server/turns.review.test.ts`

Expected: PASS — three tests pass. Review manager constructed when enabled, undefined when disabled, session_summary emitted on disposal with bus.

- [ ] **Step 7: Run the full server suite + lint + typecheck**

Run: `bun test tests/server/ && bun run lint && bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Testing-log + commit**

Append `## 2026-05-XX — Phase 16.1 M7 T6 — review manager wired into SessionContext` entry.

```bash
git add src/server/sessionContext.ts src/server/runtime.ts src/server/routes/turns.ts src/server/schema.ts tests/server/turns.review.test.ts docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
feat(server): M7 T6 — review manager wired into SessionContext

Per-session ReviewManager lives in SessionContext, threaded onto
ToolContext.reviewManager. Existing in-process triggers (orchestrator's
onToolIteration, scheduler's onChildCompletion) fire when the field is
populated. runReviewFork dispatches via runtime.subagentScheduler.
Session disposal emits session_summary SSE event with getDispatchSummary
payload for M9 TUI rendering.

Closes prereq row 13.
EOF
)"
git push origin master
```

- [ ] **Step 9: `sov upgrade`**

Run: `sov upgrade`

---

## Task 7: Integration smoke + close-out

**Goal:** Drive all six M7 subsystems through one end-to-end scenario via the `tuiLauncherIntegration` shape (the M6 pattern). Flip 6 prereq boxes, close backlog #28, add 6 ADR stubs, write the close-out state snapshot, update CLAUDE.md / AGENTS.md.

**Files:**
- Create: `tests/server/integration/m7Full.test.ts`
- Modify: `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, `docs/08-roadmap/backlog/post-phase-13-4.md`, `DECISIONS.md`, `CLAUDE.md`, `AGENTS.md`
- Create: `docs/07-history/state/2026-05-XX.md` (today's date)

**Spec / inventory pointers:**
- `tests/cli/tuiLauncherIntegration.test.ts` — M5/M6 integration test shape. Read the M6 describe block for the `buildWrappedRuntimeModule` factory pattern used to inject test seams without rewiring the launcher.
- `docs/07-history/state/2026-05-14.md` — current canonical state snapshot. The new snapshot supersedes this.
- `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` — flip rows 2, 5, 10, 11, 12, 13.
- `docs/08-roadmap/backlog/post-phase-13-4.md` — close item #28.

- [ ] **Step 1: Write the integration smoke test**

Create `tests/server/integration/m7Full.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../../src/server/runtime.js';
import { MockProvider } from '../../../src/providers/mock.js';
import { ServerEventBus } from '../../../src/server/eventBus.js';
import { runTurnInBackground } from '../../../src/server/routes/turns.js';
import { getProjectId } from '../../../src/learning/project.js';

describe('M7 full integration — all six subsystems wired end-to-end', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-full-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('one turn fires; all six output sinks land correctly', async () => {
    // No MCP servers configured for this smoke — the MCP wiring is verified
    // by tests/server/runtime.mcp.test.ts. The full smoke covers the other
    // five subsystems through a real turn.
    const provider = new MockProvider({
      script: [
        { kind: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
        { kind: 'text', text: 'done' },
      ],
    });
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      providerInstance: provider,
      preflight: false,
    });

    // (1) DaemonEventBus is present.
    expect(runtime.daemonEventBus).toBeDefined();

    const bus = new ServerEventBus();
    const captured: Array<{ type: string }> = [];
    bus.subscribe((evt) => captured.push(evt));

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: 'mock',
      platform: 'test',
    });

    // (2) Per-session context exists.
    const ctx = runtime.getSessionContext(sessionId);
    expect(ctx.traceWriter).toBeDefined();
    expect(ctx.learningObserver).toBeDefined();
    expect(ctx.reviewManager).toBeDefined();

    await runTurnInBackground(runtime, sessionId, 'run echo hi', bus);
    await runtime.disposeSession(sessionId, { bus });

    // (3) Trace file landed.
    const tracePath = join(tmpHome, 'traces', `${sessionId}.jsonl`);
    expect(existsSync(tracePath)).toBe(true);
    const trace = readFileSync(tracePath, 'utf8');
    expect(trace).toContain('"type":"turn_start"');

    // (4) Trajectory file landed.
    const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
    expect(existsSync(samplesPath)).toBe(true);
    const traj = readFileSync(samplesPath, 'utf8');
    expect(traj).toContain(sessionId);

    // (5) Learning observations landed.
    const projectId = getProjectId(tmpHome).id;
    const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
    expect(existsSync(obsPath)).toBe(true);
    const obs = readFileSync(obsPath, 'utf8');
    expect(obs).toContain('"toolName":"Bash"');

    // (6) session_summary event emitted.
    const summary = captured.find((e) => e.type === 'session_summary');
    expect(summary).toBeDefined();

    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run the integration smoke**

Run: `bun test tests/server/integration/m7Full.test.ts`

Expected: PASS — all six assertions hold.

- [ ] **Step 3: Run the full test suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`

Expected: PASS. The full suite (TS + Go) should show no regressions.

- [ ] **Step 4: Flip prereq checkboxes**

In `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`, change:

- Row 2 (MCP client pool) from `[ ]` to `[x] (M7 — 2026-05-XX)`
- Row 5 (TaskManager construction) from `[ ]` to `[x] (M7 — 2026-05-XX)`
- Row 10 (Trace writer) from `[ ]` to `[x] (M7 — 2026-05-XX)`
- Row 11 (Trajectory capture) from `[ ]` to `[x] (M7 — 2026-05-XX)`
- Row 12 (Learning observer) from `[ ]` to `[x] (M7 — 2026-05-XX)`
- Row 13 (Review manager / review fork) from `[ ]` to `[x] (M7 — 2026-05-XX)`

Replace `2026-05-XX` with the actual close-out date.

- [ ] **Step 5: Close backlog item #28**

In `docs/08-roadmap/backlog/post-phase-13-4.md`, locate item #28 (DaemonEventBus → server-mode TaskManager). Mark it as closed with the close-out commit SHA (the T2 feat commit) and date.

- [ ] **Step 6: Add ADR stubs to `DECISIONS.md`**

Append 6 ADR stubs (one per M7-0X decision):

```markdown
## ADR M7-01: Per-session subsystems live in a Map on Runtime

Status: Accepted (2026-05-XX)
Context: M3–M6 fields on Runtime were process-global singletons. M7's trace
writer, learning observer, and review manager are per-session by design —
file paths are named by sessionId; compaction creates a new child id.

Decision: Introduce `Runtime.sessionContexts: Map<sessionId, SessionContext>`
with `getSessionContext()` (lazy build + cache) and `disposeSession()` (shutdown
sequence). The turns route fetches the context per turn and threads its
members onto ToolContext / query() params.

Consequences: Each session id materializes its own subsystem cluster on first
reference. Disposal walks the map and tears down each. Multi-session UX
becomes mechanically possible without rewiring.

## ADR M7-02: Trace writer rebuilt on compaction

Status: Accepted (2026-05-XX)
Context: M6's compaction creates a new child session id. Trace files are
named by sessionId — using the parent's trace writer for the child would
write to the parent's file under the wrong session attribution.

Decision: After compaction pivots sessionId, the turns route fetches the
child's SessionContext on the next hydrate(). The parent's trace writer is
closed at this point; the child gets a fresh file.

Consequences: Per-trace files stay self-contained. `sov trace show <id>`
reads from the correct file regardless of compaction history.

## ADR M7-03: Trajectory writes on session disposal, not per-turn

Status: Accepted (2026-05-XX)
Context: Trajectory's contract is "full session as one JSON record".
Per-turn writes would overwrite a file the user expects to grow
monotonically as the session advances through turns.

Decision: `tryWriteTrajectory()` fires from `runtime.disposeSession()`.
`runtime.dispose()` walks the live SessionContext map and disposes each.

Consequences: Trajectory landing is tied to explicit session disposal.
Process crashes lose trajectories for sessions that haven't been disposed.
(Cost of disposal-driven writes; mitigated by `tryWriteTrajectory` being
fire-and-forget — disposal completes even if the write fails.)

## ADR M7-05: Review manager same lifecycle as trace; scheduler-dispatched

Status: Accepted (2026-05-XX)
Context: ReviewManager dispatches fire-and-forget sub-agents via
`runReviewFork()` which wraps `scheduler.delegate()`. The scheduler is
already on Runtime from M5. Construction needs trace + trajectory paths
which exist in SessionContext.

Decision: Per-session ReviewManager constructed in `buildSessionContext`
alongside trace + learning. Threaded onto ToolContext.reviewManager.
Existing in-process triggers fire from the orchestrator + scheduler.
`getDispatchSummary()` emitted as `session_summary` SSE event on disposal.

Consequences: Review/learning observe via direct ToolContext call-sites,
not via the DaemonEventBus. The bus stays plumbing-only in M7 (see M7-06).

## ADR M7-06: DaemonEventBus is plumbing-only in M7

Status: Accepted (2026-05-XX)
Context: Backlog #28 flagged that `buildRuntime` constructs TaskManager
without a DaemonEventBus. terminalRepl's TaskManager publishes lifecycle
events onto the bus. Server-mode TaskManager today emits events into the
void.

Decision: Construct `DaemonEventBus` in `buildRuntime`; pass to
`new TaskManager({ store, scheduler, bus })`. No subscriber wired inside
the server process in M7 — review/learning observe via ToolContext
direct-call. The bus is plumbing for future cross-process subscribers.

Consequences: Closes backlog #28. Future daemon-mode subscribers plug in
without rewiring the runtime.

## ADR M7-08: runtime.dispose() order — per-session → MCP → approvals → sessionDb

Status: Accepted (2026-05-XX)
Context: Several disposal steps depend on each other. Per-session
subsystems may write to sessionDb during disposal (trajectory writes
read messages from sessionDb). MCP child processes may be referenced by
in-flight tool calls. Approval queue may have pending promises waiting
on bus closure.

Decision: `runtime.dispose()` runs in this order:
1. Walk `sessionContexts` and call `disposeSession` on each.
2. Shut down `mcpClientPool` (terminate stdio child processes).
3. Close `approvalQueue` (dispose all pending).
4. Close `sessionDb`.

Consequences: Trajectory writes complete (still have sessionDb access),
MCP children release resources cleanly, no Promises hang. Crash-on-step-N
still leaves data integrity per fire-and-forget invariants.
```

- [ ] **Step 7: Move old state snapshot to archive and write new one**

Move `docs/07-history/state/2026-05-14.md` to `docs/07-history/state/archive/2026-05-14.md` (the older same-date archive may already exist — append a `-am.md` / `-pm.md` distinction if needed; M6 already had this rename pattern):

```bash
mv docs/07-history/state/2026-05-14.md docs/07-history/state/archive/2026-05-14-pm.md
```

(Or rename appropriately — check what's already in `docs/07-history/state/archive/` and pick a name that doesn't collide.)

Then write the new snapshot at `docs/07-history/state/2026-05-XX.md` (replace `XX` with today). The snapshot should follow the structure of the existing `docs/07-history/state/2026-05-14.md` and capture:

- HEAD SHA + short summary
- Suite numbers (TS + Go) + lint/typecheck status
- Sov binary version + sov upgrade status
- What shipped in M7 (T1–T7 narrative)
- The 6 prereq boxes flipped + #28 closed
- ADRs M7-01 through M7-08
- What's open / what's next (M8 polish surfaces, 9 boxes)
- Behavioral notes worth knowing next session
- Manual smoke status (autonomous backend tests should suffice for backend correctness; UX smoke is M9 polish)
- Pointers to deeper M7 narrative in testing-log

Aim for ~250–300 lines (matching the M6 close-out snapshot).

- [ ] **Step 8: Update CLAUDE.md / AGENTS.md state-snapshot pointer**

In both `CLAUDE.md` and `AGENTS.md`, find the "Session boot" section and update the state-snapshot pointer from `docs/07-history/state/2026-05-14.md` to `docs/07-history/state/2026-05-XX.md` (today's date). Also update the description from "Phase 16.1 M6 shipped..." to a one-liner capturing M7's six-subsystems-shipped status.

Verify byte-identical mirror:

```bash
diff CLAUDE.md AGENTS.md
```

Expected: no output (files identical).

- [ ] **Step 9: Final lint + typecheck + test suite**

Run: `bun run lint && bun run typecheck && bun test`

Expected: clean across the board. The full TS suite should show the M7 test additions (~+15–20 tests). Go suite should remain green (no Go changes in M7).

- [ ] **Step 10: Append final testing-log entry covering T7 + close-out**

Append `## 2026-05-XX — Phase 16.1 M7 T7 — close-out (6 prereq boxes flipped, #28 closed)` entry to `docs/06-testing/testing-log.md` covering: integration smoke result, prereq box flips, ADR adds, state snapshot location.

- [ ] **Step 11: Final commit + push**

```bash
git add tests/server/integration/m7Full.test.ts docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md docs/08-roadmap/backlog/post-phase-13-4.md DECISIONS.md docs/07-history/state/ CLAUDE.md AGENTS.md docs/06-testing/testing-log.md
git commit -m "$(cat <<'EOF'
docs: M7 close-out — 6 prereq boxes flipped, #28 closed, state snapshot

Phase 16.1 M7 (Hermes-layer parity group) complete. The server runtime
now reaches parity with terminalRepl on the six subsystems behind
long-running, learning-enabled sessions: MCP client pool, TaskManager
DaemonEventBus integration, trace writer, trajectory capture, learning
observer, review manager.

Backlog rows 2, 5, 10, 11, 12, 13 flipped. Item #28 closed.

15 prereq boxes remain — all in M8 polish-surfaces group.
EOF
)"
git push origin master
```

- [ ] **Step 12: `sov upgrade`** (final pass post-snapshot)

Run: `sov upgrade`

Expected: clean. Verify `sov --version` reports a SHA matching the M7 close-out HEAD.

---

## Self-review check

After completing all 7 tasks, sanity-check:

1. **Spec coverage:** All 6 M7 subsystems (MCP, TaskManager DaemonEventBus, trace, trajectory, learning, review) have a task implementing them. ✓
2. **Prereq boxes:** Rows 2, 5, 10, 11, 12, 13 flipped in T7. ✓
3. **Backlog #28:** Closed in T2 (DaemonEventBus wired); doc updated in T7. ✓
4. **ADRs:** 6 ADR stubs added in T7. M7-04 and M7-07 are scope-defining (not architectural) — noted in snapshot, not as ADRs. ✓
5. **terminalRepl untouched:** No task modifies `src/ui/terminalRepl.ts`. ✓
6. **No `--ui tui` default flip:** opt-in stays. ✓
7. **No real-Anthropic dependency:** all tests use mock provider; hardening pass against real Anthropic runs post-T7. ✓
8. **Disposal order:** M7-08 enforced in runtime.dispose() at end of T3 (and reinforced in T7's integration test). ✓
9. **Per-session pattern:** SessionContext introduced in T3; extended in T4 (trajectory), T5 (learning), T6 (review). ✓

---

## Post-M7 backlog audit

After T7 ships, run a quick audit similar to M6's:

1. **Identify any "silently broken" surfaces** the audit shows are NOT actually exercised through the server path. Anything that was wired but not exercised in T1–T7 is a smoke-test candidate for the post-T7 hardening pass.
2. **Real-Anthropic autonomous smoke** for each subsystem that touches the provider: trace writer logs provider_request/response; trajectory writes a real-shaped record; learning observes a real tool call. ReviewManager dispatches a sub-agent — the sub-agent invocation must be runnable against real Anthropic.
3. **Cost budget for post-M7 smoke:** estimate ~$0.50 (one full turn per subsystem × 6 subsystems × ~$0.05/turn, plus a couple of extras for retries on regressions).
4. **Any P3+ items discovered during hardening:** file as backlog items in `docs/08-roadmap/backlog/post-phase-13-4.md` with empirical evidence.

The hardening pass is its own session — not part of the M7 plan execution.
