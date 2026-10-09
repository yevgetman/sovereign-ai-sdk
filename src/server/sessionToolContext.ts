// Per-session ToolContext assembly, shared by the gateway turns route, the
// headless SDK host, OpenAI, cron, channels and workflows. Moved verbatim from
// src/server/routes/turns.ts (which re-exports it for existing importers).

import { readConfig } from '@yevgetman/sov-sdk/config/store';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import { buildToolContext } from '@yevgetman/sov-sdk/tool/buildToolContext';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { DelegationLifecycleEvent } from '../router/progressEvents.js';
import type { Runtime } from './runtime.js';

/** Build the per-turn ToolContext for `runTurnInBackground`'s `query()`
 *  call. Once buildRuntime constructs the scheduler + taskManager
 *  (T6 + T7), the turn-time context plumbs them onto the tool surface
 *  so AgentTool / task_create / task_list / task_get / task_output
 *  dispatch correctly. Without these four fields populated, every
 *  sub-agent and task tool throws "no scheduler / task manager in
 *  ToolContext" the moment the model invokes it.
 *
 *  The `parentToolPool` is the runtime's own pool. AgentTool reads it via
 *  ctx.parentToolPool when it forks a child session so the child inherits
 *  the parent's filtered tool surface rather than re-assembling from
 *  scratch. `canUseTool` is the session-scoped gate built in
 *  runTurnInBackground around serverAsk + the bus — the scheduler hands
 *  it through to the child AgentRunner so the same permission policy
 *  applies (parent rule layers, secrets redactor, the live SSE bridge).
 *
 *  Exported so tests/server/turns.subagent.test.ts can pin the contract
 *  without spinning up the full POST /turns + SSE drain.
 */
export function buildSessionToolContext(
  runtime: Runtime,
  sessionId: string,
  sessionCanUseTool: CanUseTool,
  opts: {
    /** Phase 2 T4 — per-turn delegation lifecycle recorder. The runtime's
     *  /turns route builds this via `synthesizeDelegationEvents(...)` and
     *  threads it down to AgentTool so the scheduler fires lifecycle
     *  events that the closure maps onto the four delegator_* SSE events.
     *  Cron + OpenAI callers pass undefined (no SSE bus to publish to). */
    delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void;
    /** Feature B — the effective tool pool for THIS turn. Defaults to the
     *  shared `runtime.toolPool` so every existing caller is byte-unchanged.
     *  The `/skill` path passes a fresh SCOPED copy (`buildToolScope(...).tools`)
     *  when the skill declares `allowedTools`, so a forked sub-agent inherits
     *  the same narrowed pool (`parentToolPool === effectivePool`) and the
     *  skill-visibility derivation tracks the tools the turn can actually use.
     *  IMPORTANT vs the shared pool: `runtime.toolPool` is a shared array
     *  mutated in place on reload; the scope is a FRESH filtered copy
     *  (`buildToolScope` always returns a new array), never a mutation of —
     *  nor an alias to — the shared pool. */
    effectivePool?: Tool<unknown, unknown>[];
  } = {},
): ToolContext {
  // Task 5.1 — the PROPRIETARY per-session resolution half. Resolve the inputs
  // off the Runtime god-object + the per-session SessionContext, then delegate
  // the pure assembly to the OPEN `buildToolContext`. The external signature +
  // returned ToolContext are byte-identical to the pre-split version — every
  // caller (gateway turns, openai, cron, channels, workflows) is unchanged.

  // M7 T5/T6 — pull the per-session subsystems off the SessionContext so
  // the orchestrator can call `ctx.learningObserver?.observe(...)` after
  // every tool call and (T6) `ctx.reviewManager` can guard review forks.
  // The context is lazily built (or cached) by Runtime.getSessionContext.
  const sessionCtx = runtime.getSessionContext(sessionId);
  // Feature B — the pool this turn actually runs against. Defaults to the
  // shared runtime pool (every existing caller); the `/skill` path overrides
  // it with the skill-scoped copy. Read-only — never mutate runtime.toolPool.
  // The open assembler derives skill visibility (activeToolNames /
  // activeToolsets / filtered skills) from this same effective pool.
  const effectivePool = opts.effectivePool ?? runtime.toolPool;
  // Task 2.3 — source WebSearchTool's provider config for `ctx.webSearch` (the
  // tool no longer reads config ambiently). An injected Settings (SDK seam,
  // config-file-free) is used verbatim; otherwise re-read config.json per turn
  // so live `webSearch.*` edits stay read-on-demand (byte-identical to the
  // tool's prior invoke-time read, now relocated to the per-turn assembler).
  const webSearch =
    runtime.injectedSettings?.webSearch ??
    readConfig({ harnessHome: runtime.harnessHome }).webSearch;
  return buildToolContext({
    cwd: runtime.cwd,
    sessionId,
    harnessHome: runtime.harnessHome,
    agents: runtime.agents,
    // Conditional in the assembler (absent when no bundle is loaded): the
    // optional `bundleRoot` field is `string | undefined`, so passing
    // `runtime.bundle?.root` directly is byte-identical to the prior
    // `runtime.bundle ? { bundleRoot: runtime.bundle.root } : {}` spread.
    bundleRoot: runtime.bundle?.root,
    subagentScheduler: runtime.subagentScheduler,
    taskManager: runtime.taskManager,
    // Phase 2 T3 — the assembled lane registry (always present on Runtime).
    laneRegistry: runtime.laneRegistry,
    effectivePool,
    // The UNFILTERED registry — the assembler filters it against the effective
    // pool. Keeping the runtime registry unfiltered preserves the T5
    // `/skillname` dispatch + the GET /skills route's own per-request view.
    skills: runtime.skills,
    canUseTool: sessionCanUseTool,
    // M8 T3 — per-session subdirectory-hint dedup state (passed by reference so
    // the dedup Set persists across the session's turn loop).
    subdirectoryHintState: sessionCtx.subdirectoryHintState,
    // Backlog #43 — per-session memory manager + project scope.
    memoryManager: sessionCtx.memoryManager,
    projectScope: sessionCtx.projectScope,
    // Task 2.3 — WebSearchTool reads its provider config off `ctx.webSearch`.
    webSearch,
    // M7 T5 — per-session learning observer (undefined when learning disabled).
    learningObserver: sessionCtx.learningObserver,
    // M7 T6 — per-session review manager (undefined when review disabled).
    reviewManager: sessionCtx.reviewManager,
    // Phase E T6 — owning principal (undefined for the implicit single principal).
    userId: sessionCtx.userId,
    // Phase 2 T4 — per-turn delegation lifecycle recorder (undefined for callers
    // with no SSE bus, e.g. cron + OpenAI).
    delegationLifecycleRecorder: opts.delegationLifecycleRecorder,
  });
}
