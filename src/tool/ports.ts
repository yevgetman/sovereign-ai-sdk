// src/tool/ports.ts — open-core port interfaces + relocated open types for ToolContext.
//
// `ToolContext` (src/tool/types.ts) is open core, so it must not import the
// proprietary `tasks/`, `review/`, `learning/`, or `router/` layers. This file
// holds the open structural PORTS that the proprietary concrete classes satisfy
// structurally (zero behavioral change) — `ReviewManagerPort`,
// `LearningObserverPort`, and `TaskManagerPort` — plus PURE DTOs relocated out
// of proprietary layers so open core can reference them directly:
// `ChildCompletionEvent` (from `review/`), and the two router types (`LaneRegistry`,
// `DelegationLifecycleEvent`, from `router/`). The task-port DTOs the
// `TaskManagerPort` signatures reference live in `core/taskPort.ts`. The
// proprietary modules re-export the relocated types, inverting the dependency so
// existing importers keep their path — the same pattern `core/observePort.ts`
// uses for `ObserveInput`.

import type { LaneConfig } from '../config/schema.js';
import type { ObserveInput } from '../core/observePort.js';
import type { CreateTaskInput, TaskOutput, TaskRecord } from '../core/taskPort.js';

/** Relocated from `src/review/manager.ts` — a pure DTO of primitives describing
 *  a completed child delegation. It lives here so open core (`ReviewManagerPort`
 *  below) can name it directly without importing the proprietary `review/`
 *  layer; `review/manager.ts` re-exports it for its existing importers. */
export interface ChildCompletionEvent {
  childSessionId: string;
  taskId: string;
  traceId: string;
  /** Phase 13.3+ throttle inputs — used by ReviewManager to skip trivial
   *  children that produced no learnable signal. */
  iterationsUsed?: number;
  toolCallCount?: number;
  /** Phase 13.4 follow-up (Item 7) — count of distinct tool names the
   *  child invoked. ReviewManager uses this to triage skill-shaped
   *  children (>= SKILL_SHAPED_MIN_TOOL_CALLS calls AND
   *  >= SKILL_SHAPED_MIN_DISTINCT_TOOLS distinct tools fires
   *  review-skill alongside review-memory). Optional for back-compat
   *  with callers that haven't been updated yet — when absent, only
   *  the default review-memory dispatch fires. */
  distinctToolCount?: number;
}

/** Open port for the proprietary `ReviewManager` (src/review/manager.ts).
 *  Contains exactly the members invoked through a `ToolContext`-typed reference:
 *   - `onToolIteration` — core/query.ts, after each successful tool batch.
 *   - `onChildCompletion` — runtime/scheduler.ts, after a child delegation
 *     completes.
 *  The completion-event parameter is the relocated `ChildCompletionEvent` DTO
 *  (above) — a pure primitive shape, so the port stays open. The concrete class
 *  satisfies this structurally — method parameters are bivariant, the shapes
 *  match. */
export interface ReviewManagerPort {
  onToolIteration(callerSessionId: string): void;
  onChildCompletion(evt: ChildCompletionEvent): void;
}

/** Open port for the proprietary `TaskManager` (src/tasks/manager.ts).
 *  Contains exactly the members invoked through a `ToolContext`-typed reference
 *  (the task_create / task_get / task_list / task_stop / task_output tools):
 *   - `create` — TaskCreateTool.
 *   - `get` — TaskGetTool.
 *   - `list` — TaskListTool.
 *   - `stop` — TaskStopTool.
 *   - `output` — TaskOutputTool.
 *  Its signatures reference the relocated open task DTOs (core/taskPort.ts), so
 *  the port stays open. The concrete class satisfies this structurally. */
export interface TaskManagerPort {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(id: string): TaskRecord | null;
  list(parentSessionId: string, opts?: { includeAll?: boolean }): TaskRecord[];
  stop(id: string): Promise<TaskRecord | null>;
  output(id: string): TaskOutput | null;
}

/** Open port for the proprietary `LearningObserver` (src/learning/observer.ts).
 *  The orchestrator calls `observe(...)` after each tool call. `ObserveInput` is
 *  already open (core/observePort.ts), so the single accessed member's signature
 *  is fully open. */
export interface LearningObserverPort {
  observe(input: ObserveInput): void;
}

/** Relocated from `src/router/laneRegistry.ts` — a pure type (the runtime half
 *  is the `buildLaneRegistry` factory, which stays in router/). It lives here so
 *  open core (`ToolContext.laneRegistry`) can reference it without importing the
 *  proprietary router/ layer; `router/laneRegistry.ts` re-exports it for its
 *  existing importers. References only `LaneConfig` (open — config/). */
export type LaneRegistry = {
  lookup: (role: string) => LaneConfig | undefined;
  entries: () => Array<{ name: string; config: LaneConfig }>;
};

/** Relocated from `src/router/progressEvents.ts` — a pure discriminated union of
 *  primitives. Open core (`ToolContext.delegationLifecycleRecorder` and the open
 *  scheduler) references it here; `router/progressEvents.ts` re-exports it for
 *  its existing importers. The scheduler fires it through
 *  `delegationLifecycleRecorder` at delegation start + completion. */
export type DelegationLifecycleEvent =
  | {
      kind: 'delegation_started';
      childSessionId: string;
      parentSessionId: string;
      agentName: string;
      laneName: string | null;
      /** Lane's resolved provider, when the lane was non-null. */
      laneProvider: string | null;
      /** Lane's resolved model — same purpose as `laneProvider`. */
      laneModel: string | null;
      promptPreview: string;
    }
  | {
      kind: 'delegation_completed';
      childSessionId: string;
      parentSessionId: string;
      agentName: string;
      laneName: string | null;
      laneProvider: string | null;
      laneModel: string | null;
      success: boolean;
      durationMs: number;
    };
