// src/core/taskPort.ts — open-core task-port DTOs.
//
// `TaskManagerPort` (src/tool/ports.ts) is the open port the proprietary
// `TaskManager` (src/tasks/manager.ts) satisfies structurally, and its method
// signatures reference these task DTOs. They and their minimal closure
// (`TaskState`, the string-literal union) live in open core so `ToolContext`
// can reference the port without importing the proprietary `tasks/` layer. The
// proprietary `tasks/` modules re-export them, inverting the dependency so
// existing importers keep their path — the same pattern `core/observePort.ts`
// uses for `ObserveInput`. The non-DTO closure (`Tool`, `ToolContext`,
// `CanUseTool`, `MemoryRuntime`, `TraceEvent`) is already open — `ToolContext`
// references all five today.

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

export type TaskOutput = {
  state: TaskState;
  summary?: string;
  iterationsUsed?: number;
  toolCallCount?: number;
  durationMs?: number;
  terminalReason?: string;
  childSessionId?: string;
  resultPreview?: string;
};
