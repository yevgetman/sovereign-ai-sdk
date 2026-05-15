// Phase 16.1 M7 T3/T4 — per-session subsystem registry.
//
// SessionContext holds the per-session subsystems that terminalRepl tracks
// directly (trace writer today; learning observer and review manager in
// M7 T5/T6). It also accumulates trajectory metadata over the session
// lifetime so disposal can flush a ShareGPT-shaped record to the
// per-bundle trajectories bucket (T4). On the server side these are
// per-session because:
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

import type { Terminal } from '../core/types.js';
import type { LearningObserver } from '../learning/observer.js';
import type { ReviewManager } from '../review/manager.js';
import { TraceWriter } from '../trace/writer.js';
import { tryWriteTrajectory } from '../trajectory/writer.js';
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
  /** Optional terminal error message. Wrapped into a `Terminal.error`
   *  `Error` at disposal time so the trajectory record carries a
   *  human-readable cause for `failed.jsonl` entries. */
  terminalError?: string;
};

/** Per-session subsystem holder. T3 wires the trace writer; T4 adds
 *  trajectory metadata; T5–T6 extend this shape with learning observer
 *  and review manager. The empty-by-default fields are intentional — they
 *  keep the type stable across follow-up tasks. */
export type SessionContext = {
  sessionId: string;
  traceWriter: TraceWriter;
  /** T4 — accumulated turn-level metadata for the final trajectory write.
   *  Mutated as the session runs; flushed by `disposeSessionContext`. */
  trajectoryMetadata: TrajectoryMetadata;
  /** T5 — populated when learning is enabled for the session. */
  learningObserver?: LearningObserver;
  /** T6 — populated when review is enabled for the session. */
  reviewManager?: ReviewManager;
};

export type BuildSessionContextOpts = {
  runtime: Runtime;
  sessionId: string;
};

/** Lazy-build a SessionContext for the given session id. Idempotent within
 *  a runtime — Runtime caches the return on first call. Construction is
 *  cheap (TraceWriter opens an append-only file handle). LearningObserver
 *  and ReviewManager are built in T5/T6. */
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
    trajectoryMetadata: {
      toolCallCount: 0,
      iterationsUsed: 0,
      estimatedCostUsd: 0,
    },
  };
}

/** Shutdown sequence for a SessionContext:
 *    1. Close the trace writer (drains pending writes to the JSONL file).
 *    2. (T5) Drain the learning observer.
 *    3. (T4) Write the trajectory record into
 *       `<artifactsRoot>/trajectories/{samples,failed}.jsonl`. Skipped when
 *       the session has no persisted messages — an empty record adds
 *       nothing but noise to the corpus.
 *    4. (T6) Emit the review manager's getDispatchSummary onto the bus.
 *
 *  Idempotent — safe to call multiple times. Errors during any step are
 *  logged and swallowed so disposal completes even if one subsystem
 *  misbehaves (Invariant #10 — best-effort disposal). */
export async function disposeSessionContext(
  ctx: SessionContext,
  opts: { runtime: Runtime; log?: (message: string) => void },
): Promise<void> {
  const { runtime } = opts;
  const log = opts.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));

  // (1) Close the trace writer first — its file is final for this sessionId.
  try {
    await ctx.traceWriter.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] trace writer close failed for ${ctx.sessionId}: ${reason}`);
  }

  // (2) T5: drain learning observer (lands when learning observer is wired).

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
      const terminal: Terminal = {
        reason: md.terminalReason ?? 'completed',
        ...(md.terminalError !== undefined ? { error: new Error(md.terminalError) } : {}),
      };
      const artifactsRoot = resolveSubagentArtifactsRoot(runtime.harnessHome, runtime.bundle);
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
    const reason = err instanceof Error ? err.message : String(err);
    log(`[sessionContext] trajectory write failed for ${ctx.sessionId}: ${reason}`);
  }

  // (4) T6: emit session_summary event (lands when review manager is wired).
}
