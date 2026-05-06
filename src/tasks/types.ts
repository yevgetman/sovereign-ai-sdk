// Phase 13.2 — Task system types. The TaskRecord is the persisted shape
// (one row per task in the `tasks` table). TaskController is the in-memory
// live state held by the manager — abort handle, output buffer, counter
// cache. CreateTaskInput is the dispatcher's input.
//
// Source of pattern: ../runtime/scheduler.ts SubagentScheduler. The task
// system is a fire-and-forget, lifecycle-aware wrapper around it.

import type { MemoryRuntime } from '../memory/provider.js';
import type { CanUseTool } from '../permissions/types.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';

export type TaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

/** Persisted shape of one task row. ISO timestamps for human-readable
 *  inspection; SQLite stores these as REAL epoch seconds underneath but the
 *  store layer translates at the boundary so callers always see ISO. */
export type TaskRecord = {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  agent: string;
  prompt: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  traceId?: string;
  resultPreview?: string;
};

/** Input shape for TaskManager.create(). Mirrors what AgentTool builds
 *  internally — the manager is the new client of SubagentScheduler. */
export type CreateTaskInput = {
  parentSessionId: string;
  agentName: string;
  prompt: string;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  canUseTool?: CanUseTool;
  memoryManager?: MemoryRuntime;
  traceRecorder?: (event: TraceEvent) => void;
};

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
