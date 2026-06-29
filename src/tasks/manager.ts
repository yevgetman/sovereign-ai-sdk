// Phase 13.2 — TaskManager. Wraps SubagentScheduler with lifecycle-aware,
// fire-and-forget delegation. The manager:
//   1. Generates a task id, writes the row as 'queued', returns to caller.
//   2. Kicks off scheduler.delegate() with parentSignal = controller.signal.
//      No await — task_create returns immediately so the model can keep
//      working while children run.
//   3. On delegate() resolution, maps terminal.reason to TaskState and
//      writes the terminal record (with child_session_id, trace_id,
//      result_preview).
//   4. On rejection, records 'failed' with the error message as preview.
//
// Cancellation: task_stop calls controller.abort.abort('user_cancel').
// The scheduler's existing parentSignal handling cascades the abort to
// the child's AgentRunner, query() loop, and tool invocations. The
// scheduler converts an aborted run into terminal.reason='interrupted';
// our terminal-mapping then distinguishes 'cancelled' (userAborted=true)
// from 'timed_out' (scheduler's per-child timeout fired without us).
//
// After a task reaches a terminal state, its TaskController is dropped
// from the in-memory `controllers` map. `output()` for terminal tasks
// returns the persisted record fields (state, childSessionId,
// resultPreview) only — the live counter cache is gone. This keeps the
// manager's memory bounded across long REPL sessions; a daemon scenario
// that needs richer terminal observability would persist counters to the
// `tasks` row instead.
//
// Known v0 limitation: the scheduler's per-parent child cap is best-
// effort under concurrent delegate() calls — see the file-header note
// in src/runtime/scheduler.ts. The manager surfaces that as a 'failed'
// terminal when the cap is breached.

import { randomUUID } from 'node:crypto';
import type { TaskOutput } from '../core/taskPort.js';
import type { Terminal } from '../core/types.js';
import type { DaemonEventBus } from '../daemon/eventBus.js';
import type { DaemonEvent } from '../daemon/types.js';
import type { SubagentScheduler } from '../runtime/scheduler.js';
import type { TaskStore, UpdateOnCompleteInput } from './store.js';
import type { CreateTaskInput, TaskController, TaskRecord, TaskState } from './types.js';

// TaskOutput is relocated to open core (src/core/taskPort.ts) so
// `TaskManagerPort.output()` references it without a proprietary import.
// Re-exported here so existing importers keep their `./manager.js` path.
export type { TaskOutput };

const PREVIEW_MAX_CHARS = 1024;

// FINDING #30 — the subscription-executor (`claude -p`) returns its
// cancel/timeout terminal IN-BAND as `reason: 'error'` (it never throws), so it
// flows through delegate()'s success tail rather than the throw path the native
// AgentRunner takes. To keep native-vs-subprocess parity we recognise the
// executor's two distinguishable abort messages (src/runtime/subprocessExecutor.ts)
// and map them to the scheduler-driven terminal states instead of 'failed'.
const SUBPROCESS_TIMEOUT_MESSAGE_RE = /timed out after/i;
const SUBPROCESS_CANCEL_MESSAGE_RE = /cancelled by scheduler signal/i;

export type TaskManagerOpts = {
  store: TaskStore;
  scheduler: SubagentScheduler;
  bus?: DaemonEventBus;
};

export class TaskManager {
  private readonly controllers = new Map<string, TaskController>();

  constructor(private readonly opts: TaskManagerOpts) {}

  /** Returns the freshly persisted record. The delegation is kicked off
   *  asynchronously; the caller does not await child completion. */
  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const id = randomUUID();
    const record = this.opts.store.insert({
      id,
      parentSessionId: input.parentSessionId,
      agent: input.agentName,
      prompt: input.prompt,
    });
    const controller: TaskController = {
      abort: new AbortController(),
      userAborted: false,
      iterationsUsed: 0,
      toolCallCount: 0,
    };
    this.controllers.set(id, controller);
    this.safeEmit({ type: 'task_update', taskId: id, state: 'queued' });
    // Fire-and-forget. We do not await this — task_create returns
    // synchronously so the model can dispatch and continue.
    void this.runDelegation(id, input, controller);
    return record;
  }

  get(id: string): TaskRecord | null {
    return this.opts.store.get(id);
  }

  list(parentSessionId: string, opts: { includeAll?: boolean } = {}): TaskRecord[] {
    return this.opts.store.listByParent(parentSessionId, opts);
  }

  /** Cooperative cancellation. Idempotent: stopping an already-terminal
   *  task is a no-op; stopping a running task transitions to 'cancelled'
   *  once the scheduler unwinds. */
  async stop(id: string): Promise<TaskRecord | null> {
    const controller = this.controllers.get(id);
    if (controller) {
      controller.userAborted = true;
      controller.abort.abort('user_cancel');
    }
    return this.opts.store.get(id);
  }

  /** Bounded output. Returns the persisted preview plus in-memory
   *  controller counters when present. Full transcript: query the child
   *  session id directly. */
  output(id: string): TaskOutput | null {
    const record = this.opts.store.get(id);
    if (!record) return null;
    const controller = this.controllers.get(id);
    // Once the task is terminal, the controller is dropped (see runDelegation).
    // For running tasks, expose the live counter cache. For terminal tasks,
    // return only the persisted fields (state + childSessionId + resultPreview).
    return {
      state: record.state,
      ...(record.childSessionId !== undefined ? { childSessionId: record.childSessionId } : {}),
      ...(record.resultPreview !== undefined ? { resultPreview: record.resultPreview } : {}),
      ...(controller?.summary !== undefined ? { summary: controller.summary } : {}),
      ...(controller !== undefined ? { iterationsUsed: controller.iterationsUsed } : {}),
      ...(controller !== undefined ? { toolCallCount: controller.toolCallCount } : {}),
      ...(controller?.durationMs !== undefined ? { durationMs: controller.durationMs } : {}),
      ...(controller?.terminalReason !== undefined
        ? { terminalReason: controller.terminalReason }
        : {}),
    };
  }

  private async runDelegation(
    id: string,
    input: CreateTaskInput,
    controller: TaskController,
  ): Promise<void> {
    try {
      this.opts.store.updateState(id, 'running');
    } catch {
      // The row was deleted between insert and the running-update — bail
      // without further progress. Not expected in v0; leave silent. Drop
      // the controller cache so the map doesn't leak entries here.
      this.controllers.delete(id);
      return;
    }
    try {
      const result = await this.opts.scheduler.delegate({
        agentName: input.agentName,
        prompt: input.prompt,
        parentSessionId: input.parentSessionId,
        parentSignal: controller.abort.signal,
        parentToolPool: input.parentToolPool,
        parentToolContext: input.parentToolContext,
        ...(input.canUseTool !== undefined ? { canUseTool: input.canUseTool } : {}),
        ...(input.memoryManager !== undefined ? { memoryManager: input.memoryManager } : {}),
        ...(input.traceRecorder !== undefined ? { traceRecorder: input.traceRecorder } : {}),
      });
      controller.iterationsUsed = result.iterationsUsed;
      controller.toolCallCount = result.toolCallCount;
      controller.durationMs = result.durationMs;
      controller.terminalReason = result.terminal.reason;
      controller.summary = result.summary;
      const finalState = mapTerminalToState(result.terminal, controller.userAborted);
      this.finalize(id, finalState, {
        state: finalState,
        childSessionId: result.childSessionId,
        traceId: result.childSessionId,
        resultPreview: bound(result.summary, PREVIEW_MAX_CHARS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const finalState: TaskState = controller.userAborted ? 'cancelled' : 'failed';
      controller.terminalReason = finalState;
      this.finalize(id, finalState, {
        state: finalState,
        resultPreview: bound(message, PREVIEW_MAX_CHARS),
      });
    }
  }

  /** FIX 4 — terminal finalization that NEVER throws. The task row is
   *  `ON DELETE CASCADE` off the parent session, so a `DELETE /sessions/:id`
   *  while a background task runs removes the row out from under us; the
   *  terminal `updateOnComplete` then throws (changes===0) or, under load,
   *  SQLITE_BUSY. `runDelegation` is fire-and-forget (void), so an escaping
   *  throw becomes an unhandled rejection AND skips the controller/emit
   *  cleanup, leaking the AbortController. We therefore persist best-effort
   *  (a missing row is benign — mirrors `updateState`'s has-row guard), then
   *  ALWAYS emit + drop the controller regardless of the write outcome. */
  private finalize(id: string, finalState: TaskState, update: UpdateOnCompleteInput): void {
    try {
      this.opts.store.updateOnComplete(id, update);
    } catch (err) {
      // Benign when the row was deleted mid-flight; logged (not rethrown) so a
      // genuine write fault (e.g. SQLITE_BUSY) is still diagnosable without
      // breaking the lifecycle. console.warn is the harness's stderr channel
      // for non-fatal background faults.
      console.warn(
        `[tasks] terminal write failed for '${id}' (row likely deleted): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.safeEmit({ type: 'task_update', taskId: id, state: finalState });
    this.controllers.delete(id);
  }

  /** Emit a daemon event without disturbing the task lifecycle. Mirrors the
   *  try/finally precedent in daemon/runner.ts:71-75 — an observability hook
   *  must never disturb the lifecycle it observes. DaemonEventBus.emit is a
   *  thin wrapper over Node EventEmitter.emit, which propagates listener
   *  throws synchronously to the emitter; this helper swallows them. */
  private safeEmit(event: DaemonEvent): void {
    if (this.opts.bus === undefined) return;
    try {
      this.opts.bus.emit(event);
    } catch {
      // Listener exceptions are swallowed by design.
    }
  }
}

function mapTerminalToState(terminal: Terminal, userAborted: boolean): TaskState {
  switch (terminal.reason) {
    case 'completed':
    case 'max_turns':
      return 'completed';
    case 'interrupted':
      return userAborted ? 'cancelled' : 'timed_out';
    case 'error':
      return mapSubprocessErrorTerminal(terminal, userAborted);
    case 'max_tokens':
      return 'failed';
    case 'checkin':
      return 'completed';
    default:
      return 'failed';
  }
}

/** An in-band `reason: 'error'` terminal is normally a genuine failure
 *  ('failed'). But the subprocess executor surfaces a user-cancel / timeout
 *  abort in-band as an error terminal (it never throws), so we recover the
 *  scheduler-driven states the native path gets via `reason: 'interrupted'`:
 *  a user abort → 'cancelled'; a (scheduler / internal) timeout → 'timed_out'.
 *  A genuine error (non-zero exit, result error, truncated stream) → 'failed'. */
function mapSubprocessErrorTerminal(terminal: Terminal, userAborted: boolean): TaskState {
  if (userAborted) return 'cancelled';
  const message = terminal.error?.message ?? '';
  if (SUBPROCESS_TIMEOUT_MESSAGE_RE.test(message)) return 'timed_out';
  // A scheduler-signal cancel without an explicit user stop (e.g. the
  // scheduler's per-child deadline propagated through opts.signal) is a
  // deadline expiry, mapped to 'timed_out' to mirror the native path's
  // `interrupted` + !userAborted branch.
  if (SUBPROCESS_CANCEL_MESSAGE_RE.test(message)) return 'timed_out';
  return 'failed';
}

function bound(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
