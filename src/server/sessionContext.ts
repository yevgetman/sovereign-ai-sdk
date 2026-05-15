// Phase 16.1 M7 T3 — per-session subsystem registry.
//
// SessionContext holds the per-session subsystems that terminalRepl tracks
// directly (trace writer today; learning observer and review manager in
// M7 T5/T6; trajectory metadata in T4). On the server side these are
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
// written monolithically in T3 with placeholder fields so T4/T5/T6 have a
// stable shape to extend without churning callers.

import type { LearningObserver } from '../learning/observer.js';
import type { ReviewManager } from '../review/manager.js';
import { TraceWriter } from '../trace/writer.js';
import type { Runtime } from './runtime.js';

/** Per-session subsystem holder. T3 wires the trace writer; T4–T6 extend
 *  this shape with trajectory metadata, learning observer, and review
 *  manager. The empty-by-default fields are intentional — they keep the
 *  type stable across follow-up tasks. */
export type SessionContext = {
  sessionId: string;
  traceWriter: TraceWriter;
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
  };
}

/** Shutdown sequence for a SessionContext:
 *    1. Close the trace writer (drains pending writes to the JSONL file).
 *    2. (T5) Drain the learning observer.
 *    3. (T4) Write the trajectory record.
 *    4. (T6) Emit the review manager's getDispatchSummary onto the bus.
 *
 *  Idempotent — safe to call multiple times. Errors during any step are
 *  logged and swallowed so disposal completes even if one subsystem
 *  misbehaves (Invariant #10 — best-effort disposal). */
export async function disposeSessionContext(
  ctx: SessionContext,
  opts?: { log?: (message: string) => void },
): Promise<void> {
  const log = opts?.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));

  try {
    await ctx.traceWriter.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[m7] trace writer close failed for ${ctx.sessionId}: ${reason}`);
  }

  // T5: drain learning observer.
  // T4: write trajectory.
  // T6: emit session_summary event.
}
