// Phase 13.2 — Task system types. The TaskRecord is the persisted shape
// (one row per task in the `tasks` table). TaskController is the in-memory
// live state held by the manager — abort handle, output buffer, counter
// cache. CreateTaskInput is the dispatcher's input.
//
// Source of pattern: ../runtime/scheduler.ts SubagentScheduler. The task
// system is a fire-and-forget, lifecycle-aware wrapper around it.

// TaskState, TaskRecord, and CreateTaskInput are relocated to open core
// (src/core/taskPort.ts) so `ToolContext.taskManager`'s `TaskManagerPort` can
// reference them without importing this proprietary layer. Re-exported here so
// existing importers keep their `./types.js` path (single source of truth =
// core/taskPort.ts).
export type { CreateTaskInput, TaskRecord, TaskState } from '../core/taskPort.js';

/** Live, in-memory bookkeeping for a single running task. Held in
 *  TaskManager's Map<taskId, TaskController>. Survives only as long as
 *  the REPL process; the persisted TaskRecord is the cross-restart
 *  source of truth. */
export type TaskController = {
  /** AbortController fed into scheduler.delegate(). task_stop calls
   *  controller.abort.abort('user_cancel'). */
  abort: AbortController;
  /** Set when task_stop was the cause of abort, so terminal-reason
   *  mapping can distinguish 'cancelled' from 'timed_out'. */
  userAborted: boolean;
  /** Cached for task_output while the task is still running. */
  iterationsUsed: number;
  toolCallCount: number;
  /** Populated on terminal. */
  durationMs?: number;
  terminalReason?: string;
  summary?: string;
};
