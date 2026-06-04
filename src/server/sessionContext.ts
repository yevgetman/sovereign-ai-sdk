// Phase 16.1 M7 T3/T4 — per-session subsystem registry.
//
// SessionContext holds the per-session subsystems the server runtime
// tracks for each active session (trace writer, learning observer,
// review manager). It also accumulates trajectory metadata over the
// session lifetime so disposal can flush a ShareGPT-shaped record to
// the per-bundle trajectories bucket (T4). These are per-session because:
//   (a) their state is scoped to a single sessionId,
//   (b) the file paths they write to are named by sessionId, and
//   (c) M6 compaction creates a new child sessionId that warrants a fresh
//       context.
//
// Runtime owns a `Map<sessionId, SessionContext>` with lazy-build semantics:
// the first `runtime.getSessionContext(sessionId)` call builds and caches;
// later calls return the cached instance. `runtime.disposeSession(sessionId)`
// evicts from the map and tears down per-session subsystems. The file is
// written monolithically with stub fields so T5/T6 have a stable shape
// to extend without churning callers.

import { readConfig } from '../config/store.js';
import {
  type SubdirectoryHintState,
  createSubdirectoryHintState,
} from '../context/subdirectoryHints.js';
import type { RecallTurn, Terminal } from '../core/types.js';
import { LearningObserver } from '../learning/observer.js';
import { GLOBAL_PROJECT_ID, instinctsDir } from '../learning/paths.js';
import { getProjectId } from '../learning/project.js';
import { type MemoryManager, createDefaultMemoryManager } from '../memory/provider.js';
import { type ProjectScope, resolveProjectScope } from '../memory/scope.js';
import { ReviewManager } from '../review/manager.js';
import { TraceWriter } from '../trace/writer.js';
import { tryWriteTrajectory } from '../trajectory/writer.js';
import type { ServerEventBus } from './eventBus.js';
import { resolveSubagentArtifactsRoot } from './runtime.js';
import type { Runtime } from './runtime.js';

/** Accumulated metadata flushed into the trajectory record at disposal time.
 *  Default zeros on `buildSessionContext`; turn-time updates (toolCallCount,
 *  iterationsUsed, estimatedCostUsd) and any terminal-reason override land
 *  in follow-up polish per the T4 plan. */
export type TrajectoryMetadata = {
  toolCallCount: number;
  iterationsUsed: number;
  estimatedCostUsd: number;
  /** Optional terminal reason. Default 'completed' is applied at disposal
   *  time when this is unset — the absence of a recorded error implies a
   *  graceful end. The union mirrors `Terminal['reason']` so the trajectory
   *  writer's bucket selection (completed vs failed) works without a cast. */
  terminalReason?: Terminal['reason'];
};

/** Per-session subsystem holder. T3 wires the trace writer; T4 adds
 *  trajectory metadata; T5 adds the learning observer; T6 adds the review
 *  manager + its abort controller. The empty-by-default optional fields
 *  are intentional — they keep the type stable when subsystems are
 *  disabled in user settings. */
export type SessionContext = {
  sessionId: string;
  traceWriter: TraceWriter;
  /** T4 — accumulated turn-level metadata for the final trajectory write.
   *  Mutated as the session runs; flushed by `disposeSessionContext`. */
  trajectoryMetadata: TrajectoryMetadata;
  /** T5 — populated when learning is enabled for the session. */
  learningObserver?: LearningObserver;
  /** T6 — populated when review is enabled for the session. Optional-chain
   *  call sites (`ctx.reviewManager?.onToolIteration(...)`) become a no-op
   *  when review.disabled === true. */
  reviewManager?: ReviewManager;
  /** T6 — abort signal source for in-flight review-fork sub-agents. Always
   *  present (whether or not reviewManager was constructed) so disposal can
   *  unconditionally abort()  without a guard; review forks were the only
   *  consumer, and we abort upstream before reaching getDispatchSummary so
   *  no lingering background work survives session teardown. */
  reviewAbortController: AbortController;
  /** M8 T3 — per-session ancestor-walk dedup state for subdirectory hints.
   *  Populated by `createSubdirectoryHintState()` at SessionContext build
   *  time and threaded onto every ToolContext built for this session by
   *  `buildSessionToolContext` (src/server/routes/turns.ts). Consumed by
   *  the orchestrator's `appendSubdirectoryHints` call after every
   *  successful tool result (src/core/orchestrator.ts:640-653) — the
   *  `touched` Set guarantees a directory's AGENTS.md / CONTEXT.md /
   *  .cursorrules files are appended at most once per session. The state
   *  is carried on the session because turns are independent requests
   *  rather than a single in-process loop. */
  subdirectoryHintState: SubdirectoryHintState;
  /** Backlog #43 (closed 2026-05-19) — per-session memory manager +
   *  project scope. Threaded onto ToolContext by buildSessionToolContext
   *  so MemoryTool's `ctx.memoryManager?.onMemoryWrite(...)`
   *  notifications fire and `ctx.projectScope` routes writes correctly
   *  between global and per-project MEMORY.md. The built-in markdown
   *  provider's initialize/onSessionStart are no-ops so construction
   *  stays synchronous (matches buildSessionContext's existing shape); if
   *  a non-builtin provider that needs async init is added later, this
   *  constructor will need to be promoted to async + initialize() called
   *  on first use. */
  memoryManager: MemoryManager;
  projectScope: ProjectScope;
  /** Learning-loop spike Phase 1 — per-session recall thunk, bound to this
   *  session's project id. Present only when `learning.recall.enabled` is
   *  true; left undefined otherwise so the turns route omits it from the
   *  query() call and recall stays inert (default behavior unchanged). The
   *  turns route threads this onto the query() params; query() runs it
   *  after memory injection and prepends recalled lessons to the latest
   *  user message. */
  recall?: RecallTurn;
};

export type BuildSessionContextOpts = {
  runtime: Runtime;
  sessionId: string;
};

/** Lazy-build a SessionContext for the given session id. Idempotent within
 *  a runtime — Runtime caches the return on first call. Construction is
 *  cheap: TraceWriter opens an append-only file handle, LearningObserver
 *  defers all disk work to first observe() call, ReviewManager defers all
 *  scheduler dispatch to its first counter-tripping trigger. */
export function buildSessionContext(opts: BuildSessionContextOpts): SessionContext {
  const { runtime, sessionId } = opts;

  const traceWriter = new TraceWriter({
    sessionId,
    harnessHome: runtime.harnessHome,
  });
  // Whole-branch review I3 — emit `session_start` immediately so trace
  // files carry a header bookend. Without this, `sov trace show
  // <sessionId>` can't render the provider/model/cwd header line. The
  // optional `bundlePath` is emitted when a bundle is loaded; omitted
  // when no bundle is present (e.g., pure --provider mock).
  traceWriter.record({
    type: 'session_start',
    iso: new Date().toISOString(),
    sessionId,
    provider: runtime.resolvedProvider.transport.name,
    model: runtime.model,
    cwd: runtime.cwd,
    ...(runtime.bundle ? { bundlePath: runtime.bundle.root } : {}),
  });

  // Settings cascade is read ONCE per SessionContext construction so a
  // `sov config set <key> <val>` mid-process takes effect on the next
  // session without a restart. Both T5 (learning) and T6 (review) consume
  // the result — keeping the read singular avoids the duplicate-disk-hit
  // smell the T5 reviewer flagged as a watch item for T6.
  const userSettings = readConfig();

  // M7 T5 — per-session learning observer.
  //
  // When `learning.disabled === true`, the field is LEFT UNDEFINED so the
  // orchestrator's `ctx.learningObserver?.observe(...)` optional-chain
  // becomes a no-op and disposal skips the drain step entirely (no empty
  // observations.jsonl created).
  const learningEnabled = userSettings.learning?.disabled !== true;
  const learningObserver: LearningObserver | undefined = learningEnabled
    ? new LearningObserver({
        harnessHome: runtime.harnessHome,
        cwd: runtime.cwd,
        sessionId,
        ...(userSettings.learning?.observationBufferSize !== undefined
          ? { bufferSize: userSettings.learning.observationBufferSize }
          : {}),
        enabled: true,
      })
    : undefined;

  // M7 T6 — per-session review manager. AbortController is always built so
  // disposal can unconditionally abort(); the ReviewManager itself is only
  // constructed when review.disabled !== true. When disabled, the field is
  // left undefined and the orchestrator's ctx.reviewManager?.onToolIteration
  // / scheduler's parentToolContext.reviewManager?.onChildCompletion calls
  // become no-ops.
  //
  // parentToolContext: see plan note. ReviewManager passes parentToolContext
  // through to scheduler.delegate(), which spreads it into the child
  // ToolContext (src/runtime/scheduler.ts:195). The full per-turn ToolContext
  // is only assembled inside buildSessionToolContext at turn time, so we
  // build a minimal snapshot here covering the fields the spread surfaces
  // need (cwd, sessionId, harnessHome, agents, subagentScheduler, taskManager,
  // parentToolPool). The scheduler's tool filtering pulls augmenting tools
  // (REVIEW_ONLY_TOOLS, LEARNING_ONLY_TOOLS) directly inside runReviewFork —
  // it doesn't read them off parentToolContext.
  const reviewEnabled = userSettings.review?.disabled !== true;
  const reviewAbortController = new AbortController();
  const reviewManager: ReviewManager | undefined = reviewEnabled
    ? new ReviewManager({
        scheduler: runtime.subagentScheduler,
        sessionId,
        signal: reviewAbortController.signal,
        thresholds: {
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
            ? {
                synthesizerEveryNToolIterations:
                  userSettings.learning.synthesizerEveryNToolIterations,
              }
            : {}),
          ...(userSettings.learning?.synthesizeOnSessionEndAfter !== undefined
            ? {
                synthesizeOnSessionEndAfter: userSettings.learning.synthesizeOnSessionEndAfter,
              }
            : {}),
        },
        pathsResolver: () => ({
          trajectoryPath: `${resolveSubagentArtifactsRoot(runtime.harnessHome, runtime.bundle)}/trajectories/samples.jsonl`,
          tracePath: traceWriter.path,
          instinctsDir: instinctsDir(runtime.harnessHome, getProjectId(runtime.cwd).id),
        }),
        parentToolPool: runtime.toolPool,
        parentToolContext: {
          cwd: runtime.cwd,
          sessionId,
          harnessHome: runtime.harnessHome,
          agents: runtime.agents,
          subagentScheduler: runtime.subagentScheduler,
          taskManager: runtime.taskManager,
          // Phase 2 T3 — thread the lane registry onto the
          // review-fork parent context too so review-spawned children
          // honor the same lane timeoutMs as the turn-level pool.
          laneRegistry: runtime.laneRegistry,
          parentToolPool: runtime.toolPool,
          // Backlog #38 (closed 2026-05-19) — auto-promote opt-ins from
          // settings.review thread through to children so the runtime
          // honors the user-configured auto-promote behavior. Optional
          // spread to keep the omitted-when-false invariant (matches the
          // M5.1 review's "don't lie about state we don't have"
          // convention).
          ...(userSettings.review?.autoPromoteMemory === true
            ? { reviewAutoPromoteMemory: true }
            : {}),
          ...(userSettings.review?.autoPromoteSkills === true
            ? { reviewAutoPromoteSkills: true }
            : {}),
        },
        enabled: true,
        traceRecorder: (event) => traceWriter.record(event),
        projectIdentity: () => getProjectId(runtime.cwd),
        harnessHome: runtime.harnessHome,
      })
    : undefined;

  // Backlog #43 (closed 2026-05-19) — resolve project scope + construct
  // the default memory manager. The built-in markdown provider's
  // initialize() and onSessionStart() are no-ops, so we can construct
  // synchronously without making buildSessionContext itself async.
  // Disposal calls onSessionEnd + shutdown to drain any provider state.
  const projectScope = resolveProjectScope({
    cwd: runtime.cwd,
    bundle: runtime.bundle ?? null,
    harnessHome: runtime.harnessHome,
  });
  const memoryManager = createDefaultMemoryManager(runtime.harnessHome, projectScope);

  // Learning-loop spike Phase 1 — per-session recall thunk. Built only when
  // `learning.recall.enabled` is true (default false → field left undefined
  // → the turns route omits `recall` from query() → recall stays inert, so
  // default behavior is unchanged). Bound to this session's project id:
  // when the session is in a project (bundle or git repo) we recall that
  // project's instincts; otherwise we recall the global corpus
  // (GLOBAL_PROJECT_ID), matching the instinct store's global-scope key.
  // Fail-open is the layer's own responsibility — `learningLayer.recall`
  // swallows errors and returns an empty result rather than breaking the
  // turn.
  const recallCfg = userSettings.learning?.recall;
  const recallProjectId = projectScope.kind === 'project' ? projectScope.id : GLOBAL_PROJECT_ID;
  const recall: RecallTurn | undefined = recallCfg?.enabled
    ? (latestUserText) =>
        runtime.learningLayer.recall({
          projectId: recallProjectId,
          latestUserText,
          tokenBudget: recallCfg.tokenBudget ?? 1200,
          maxLessons: recallCfg.maxLessons ?? 8,
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
    reviewAbortController,
    // M8 T3 — fresh per-session hint state; `touched` starts empty and
    // accumulates directories as tools fire across the session's turns.
    subdirectoryHintState: createSubdirectoryHintState(),
    memoryManager,
    projectScope,
    ...(recall !== undefined ? { recall } : {}),
    ...(learningObserver !== undefined ? { learningObserver } : {}),
    ...(reviewManager !== undefined ? { reviewManager } : {}),
  };
}

/** Shutdown sequence for a SessionContext:
 *    1. Close the trace writer (drains pending writes to the JSONL file).
 *    2. (T5) Drain the learning observer.
 *    3. (T4) Write the trajectory record into
 *       `<artifactsRoot>/trajectories/{samples,failed}.jsonl`. Skipped when
 *       the session has no persisted messages — an empty record adds
 *       nothing but noise to the corpus.
 *    3.5 (Task 14) Fire the end-of-session synthesis trigger BEFORE the
 *       review abort — the ReviewManager dispatches the instinct-synthesizer
 *       over this session's accrued observations when the new-activity
 *       threshold is met. This closes the N → N+1 learning loop.
 *    4. (T6) Abort any in-flight review-fork sub-agents, then emit a
 *       `session_summary` SSE event with the ReviewManager's dispatch
 *       summary. The event is only emitted when `opts.bus` is supplied:
 *       runtime.dispose()'s shutdown walk omits the bus (no SSE consumer
 *       remains at process shutdown — the event would land on the void),
 *       so the summary is logged to stderr instead.
 *
 *  Idempotent — safe to call multiple times. Errors during any step are
 *  logged and swallowed so disposal completes even if one subsystem
 *  misbehaves (Invariant #10 — best-effort disposal). */
export async function disposeSessionContext(
  ctx: SessionContext,
  opts: { runtime: Runtime; bus?: ServerEventBus; log?: (message: string) => void },
): Promise<void> {
  const { runtime } = opts;
  const log = opts.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));

  // (1) Close the trace writer first — its file is final for this sessionId.
  //     Whole-branch review I3 — emit `session_end` as the closing bookend
  //     BEFORE close() so the closing event lands in the JSONL. Without
  //     this, `sov trace show` won't close out the final turn group.
  //     Default reason is 'completed' when no error was recorded on
  //     `trajectoryMetadata.terminalReason`.
  try {
    ctx.traceWriter.record({
      type: 'session_end',
      iso: new Date().toISOString(),
      reason: ctx.trajectoryMetadata.terminalReason ?? 'completed',
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] session_end record failed for ${ctx.sessionId}: ${reason}`);
  }
  try {
    await ctx.traceWriter.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] trace writer close failed for ${ctx.sessionId}: ${reason}`);
  }

  // (2) T5: drain the learning observer's write chain. Bounded by the
  //     observer's internal timeout (default 2000ms) so a stalled disk
  //     can't hang disposal. Skipped when the observer was never built
  //     (learning.disabled === true path).
  if (ctx.learningObserver) {
    try {
      await ctx.learningObserver.drain();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`[sessionContext] learning observer drain failed for ${ctx.sessionId}: ${reason}`);
    }
  }

  // (3) T4: write the trajectory record. Best-effort — `tryWriteTrajectory`
  //     swallows its own filesystem errors; we still wrap the surrounding
  //     calls (loadMessages, artifactsRoot resolution) defensively so a
  //     DB transient never blocks the rest of disposal.
  try {
    const messages = runtime.sessionDb.loadMessages(ctx.sessionId).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    if (messages.length > 0) {
      const md = ctx.trajectoryMetadata;
      const terminal: Terminal = { reason: md.terminalReason ?? 'completed' };
      const artifactsRoot = resolveSubagentArtifactsRoot(runtime.harnessHome, runtime.bundle);
      // Whole-branch review I1 — read cost from sessionDb at write time
      // so the trajectory record carries the actual chat + compaction
      // cost the session accumulated (estimatedCostUsd +
      // estimatedCompactionCostUsd). Falls back to the accumulator on
      // the SessionContext when the DB read returns zeros (e.g., a fresh
      // session with no usage rows yet)
      // so a test that sets trajectoryMetadata.estimatedCostUsd by hand
      // still surfaces its value.
      const cost = runtime.sessionDb.getSessionCost(ctx.sessionId);
      const dbCost = cost.estimatedCostUsd + cost.estimatedCompactionCostUsd;
      const estimatedCostUsd = dbCost > 0 ? dbCost : md.estimatedCostUsd;
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
            estimatedCostUsd,
          },
          artifactsRoot,
        },
        log,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] trajectory write failed for ${ctx.sessionId}: ${reason}`);
  }

  // (3.5) Learning-loop spike Task 14 — END-OF-SESSION synthesis trigger.
  //       Fire the synthesizer over this session's accrued observations
  //       BEFORE the review abort below (the synthesizer's own
  //       signal-aborted guard would otherwise suppress it). This is what
  //       closes the N → N+1 learning loop: a short session rarely trips
  //       the periodic synthesizer counters, so without this hook a
  //       session's observations would never be synthesized before the
  //       next session begins. The ReviewManager internally gates on the
  //       new-activity threshold + minIntervalMs + projectIdentity guards,
  //       and the dispatch is fire-and-forget (never blocks disposal).
  //       Best-effort — a throw here must not abort the rest of teardown.
  try {
    ctx.reviewManager?.onSessionEnd();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] end-of-session synthesis trigger failed for ${ctx.sessionId}: ${reason}`);
  }

  // (4) T6: abort any in-flight review forks and emit the dispatch summary.
  //     The abort fires unconditionally (so a stuck review-fork can't
  //     outlive the session) but the summary read + emit only runs when
  //     a manager was built. When `opts.bus` is absent (the runtime
  //     shutdown walk), the summary is logged to stderr — there's no SSE
  //     consumer to receive it at process teardown.
  try {
    ctx.reviewAbortController.abort();
    if (ctx.reviewManager) {
      const summary = ctx.reviewManager.getDispatchSummary();
      if (opts.bus) {
        // M8 T7 — rich session_summary payload. The metrics snapshot folds
        // chat + compaction lanes into a single goodbye-card view and
        // counts tool_use blocks across the persisted transcript so the
        // M9 renderer can surface "X tool calls, $Y cost" without a
        // separate fetch. All extension fields are optional in the wire
        // schema — empty sessions still produce a valid event for the
        // "ended a fresh session" path.
        const metrics = readSessionMetricsSafely(ctx.sessionId, runtime, log);
        // Bus-attached disposal: emit unconditionally so the TUI can render
        // a goodbye card even when no reviews fired (an empty card still
        // confirms the session ended).
        opts.bus.publish({
          type: 'session_summary',
          seq: opts.bus.nextSeq(),
          sessionId: ctx.sessionId,
          totalDispatched: summary.totalDispatched,
          byAgent: summary.byAgent,
          ...(metrics !== null
            ? {
                tokens: metrics.tokens,
                toolCalls: metrics.toolCalls,
                toolOk: metrics.toolOk,
                toolErr: metrics.toolErr,
              }
            : {}),
        });
      } else if (summary.totalDispatched > 0) {
        // Process-shutdown walk: no SSE consumer, so the summary is
        // informational only. Skip the log when nothing fired — the line
        // would otherwise spam stderr across every test that calls
        // runtime.dispose() against the default review-enabled config.
        log(
          `[sessionContext] session_summary for ${ctx.sessionId}: dispatched=${summary.totalDispatched} byAgent=${JSON.stringify(summary.byAgent)}`,
        );
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] review summary failed for ${ctx.sessionId}: ${reason}`);
  }

  // (5) Backlog #43 — drain the memory manager. Built-in provider's
  //     onSessionEnd/shutdown are no-ops, so this is currently
  //     pass-through; the structure is in place for non-builtin providers
  //     that need to flush state on session end.
  try {
    await ctx.memoryManager.onSessionEnd(ctx.sessionId);
    await ctx.memoryManager.shutdown();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] memory manager teardown failed for ${ctx.sessionId}: ${reason}`);
  }
}

/** M8 T7 — best-effort wrapper around `sessionDb.getSessionMetrics`. Returns
 *  null on failure so the surrounding session_summary publish can still
 *  emit the M7-shape payload (just without the extended fields). Mirrors
 *  the swallow-and-log pattern the rest of disposeSessionContext uses for
 *  best-effort disposal (Invariant #10). */
function readSessionMetricsSafely(
  sessionId: string,
  runtime: Runtime,
  log: (message: string) => void,
): ReturnType<Runtime['sessionDb']['getSessionMetrics']> | null {
  try {
    return runtime.sessionDb.getSessionMetrics(sessionId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] getSessionMetrics failed for ${sessionId}: ${reason}`);
    return null;
  }
}
