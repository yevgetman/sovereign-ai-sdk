// src/tool/ports.ts — open-core port interfaces + relocated open types for ToolContext.
//
// `ToolContext` (src/tool/types.ts) is open core, so it must not import the
// proprietary `tasks/`, `review/`, `learning/`, or `router/` layers. This file
// holds the open structural PORTS that the proprietary concrete classes satisfy
// structurally (zero behavioral change), plus two PURE router types relocated
// out of the proprietary `router/` layer so open core can reference them
// directly. The proprietary modules re-export the relocated types, inverting the
// dependency so existing importers keep their path — the same pattern
// `core/observePort.ts` uses for `ObserveInput`.

import type { LaneConfig } from '../config/schema.js';
import type { ObserveInput } from '../core/observePort.js';

/** Open port for the proprietary `ReviewManager` (src/review/manager.ts).
 *  Contains exactly the members invoked through a `ToolContext`-typed reference:
 *   - `onToolIteration` — core/query.ts, after each successful tool batch.
 *   - `onChildCompletion` — runtime/scheduler.ts, after a child delegation
 *     completes.
 *  The completion-event parameter is expressed as an inline primitive shape
 *  (mirroring `review/manager.ts`'s `ChildCompletionEvent`, a pure DTO) so the
 *  port references only primitives and stays open. The concrete class satisfies
 *  this structurally — method parameters are bivariant, and the shapes match. */
export interface ReviewManagerPort {
  onToolIteration(callerSessionId: string): void;
  onChildCompletion(evt: {
    childSessionId: string;
    taskId: string;
    traceId: string;
    iterationsUsed?: number;
    toolCallCount?: number;
    distinctToolCount?: number;
  }): void;
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
