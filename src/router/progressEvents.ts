// Phase 2 T4 — Runtime-synthesized delegator SSE events.
//
// The runtime observes the scheduler's delegation lifecycle (start + end of
// every `scheduler.delegate()` call) and publishes four new SSE event types
// on the per-session event bus so the TUI, `sov drive`, and the OpenAI
// side-channel can render router progress:
//
//   - delegator_plan         — when the delegator session itself starts
//   - delegator_atom_started — when the delegator dispatches an atom
//   - delegator_atom_complete — when an atom completes
//   - delegator_complete     — when the delegator session ends
//
// Mechanism: the scheduler fires an optional `delegationLifecycleRecorder`
// callback at delegation start + completion (purely additive — every
// existing call site that omits the callback keeps the identical pre-T4
// behavior). The runtime constructs a `synthesizeDelegationEvents(...)`
// closure per turn that maps those lifecycle events onto the four
// delegator_* SSE events. The bus knowledge stays in the runtime; the
// scheduler stays bus-unaware.
//
// Atom detection: the closure tracks `activeDelegatorSessionId`. When
// the delegator dispatches (the `delegation_started` event carries
// `agentName === 'delegator'`), the closure records its childSessionId.
// Subsequent `delegation_started` events whose `parentSessionId` matches
// the active delegator's childSessionId are atoms — they fire the
// `delegator_atom_started` event. Delegations whose parentSessionId
// doesn't match (regular sub-agent calls from the root) are ignored.
//
// Plan: docs/plans/2026-05-23-phase-2-task-routing.md (T4)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { z } from 'zod';
import type { AgentRegistry } from '../agents/types.js';
import type { ServerEventBus } from '../server/eventBus.js';
import type { DelegationLifecycleEvent } from '../tool/ports.js';

// The internal lifecycle event the scheduler fires through
// `delegationLifecycleRecorder` (discriminated by `kind`) is a pure primitive
// union, relocated to open core (src/tool/ports.ts) so `ToolContext` and the
// open scheduler can reference it without importing this proprietary router
// module. The runtime's synthesis closure (below) consumes these and
// re-publishes them as one of the four delegator_* SSE events when they belong
// to the active delegator call graph. Re-exported here so existing importers
// keep their path.
export type { DelegationLifecycleEvent };

// --- Wire-event Zod schemas -------------------------------------------------

export const DelegatorPlanEventSchema = z.object({
  type: z.literal('delegator_plan'),
  seq: z.number().int(),
  sessionId: z.string(),
  scheduledAtomCount: z.number().int().optional(),
});

export const DelegatorAtomStartedEventSchema = z.object({
  type: z.literal('delegator_atom_started'),
  seq: z.number().int(),
  sessionId: z.string(),
  atomIndex: z.number().int(),
  laneName: z.string(),
  promptPreview: z.string(),
  /** 2026-05-24 patch — resolved provider/model for the lane. The TUI
   *  surfaces these in debug-mode rendering. Optional so old
   *  recorded sessions (replayed from JSONL) still parse. */
  laneProvider: z.string().optional(),
  laneModel: z.string().optional(),
});

export const DelegatorAtomCompleteEventSchema = z.object({
  type: z.literal('delegator_atom_complete'),
  seq: z.number().int(),
  sessionId: z.string(),
  atomIndex: z.number().int(),
  laneName: z.string(),
  success: z.boolean(),
  durationMs: z.number().int(),
  laneProvider: z.string().optional(),
  laneModel: z.string().optional(),
});

export const DelegatorCompleteEventSchema = z.object({
  type: z.literal('delegator_complete'),
  seq: z.number().int(),
  sessionId: z.string(),
  totalAtomCount: z.number().int(),
  laneDistribution: z.record(z.string(), z.number().int()),
});

export type DelegatorPlanEvent = z.infer<typeof DelegatorPlanEventSchema>;
export type DelegatorAtomStartedEvent = z.infer<typeof DelegatorAtomStartedEventSchema>;
export type DelegatorAtomCompleteEvent = z.infer<typeof DelegatorAtomCompleteEventSchema>;
export type DelegatorCompleteEvent = z.infer<typeof DelegatorCompleteEventSchema>;

// --- Synthesis closure ------------------------------------------------------

/** Cap on the promptPreview text length. Atoms can have long prompts; the
 *  wire event is meant for human-readable rendering (compact-line in the
 *  TUI, plain text in `sov drive`), so we truncate well below the bus
 *  envelope budget. */
const PROMPT_PREVIEW_MAX = 80;

function previewPrompt(prompt: string): string {
  if (prompt.length <= PROMPT_PREVIEW_MAX) return prompt;
  return `${prompt.slice(0, PROMPT_PREVIEW_MAX - 1)}…`;
}

export type SynthesizeDelegationEventsOpts = {
  bus: ServerEventBus;
  rootSessionId: string;
  agentRegistry: AgentRegistry;
};

/**
 * Build a `delegationLifecycleRecorder` closure that observes scheduler
 * delegation events and publishes the four delegator_* SSE events onto the
 * per-session bus. The closure is stateful — it tracks the currently active
 * delegator session id so it can attribute subsequent dispatches as atoms.
 *
 * State lifecycle:
 *   1. delegation_started with agentName === 'delegator'
 *      → record `activeDelegatorSessionId`, publish `delegator_plan`.
 *   2. delegation_started with parentSessionId === active id, laneName != null
 *      → assign incrementing atomIndex, publish `delegator_atom_started`.
 *   3. delegation_completed for a tracked atom childSessionId
 *      → publish `delegator_atom_complete` using the recorded atomIndex.
 *   4. delegation_completed with childSessionId === active id
 *      → publish `delegator_complete`, reset state.
 *
 * Anything outside this state machine (non-delegator sub-agent calls, nested
 * delegators, etc.) is silently ignored. Each closure instance is bound to
 * exactly one user turn / root session — the runtime constructs a fresh one
 * per turn in `src/server/routes/turns.ts`.
 */
export function synthesizeDelegationEvents(
  opts: SynthesizeDelegationEventsOpts,
): (event: DelegationLifecycleEvent) => void {
  let activeDelegatorSessionId: string | null = null;
  let atomCounter = 0;
  // Lane distribution accumulator for the final `delegator_complete` event.
  // Reset each time a new delegator session starts.
  const laneDistribution: Record<string, number> = {};
  // Map from an atom's childSessionId to the atomIndex assigned at its
  // dispatch, so the matching completion event emits the same index.
  const atomIndexByChildSessionId = new Map<string, number>();

  const resetDelegatorState = (): void => {
    activeDelegatorSessionId = null;
    atomCounter = 0;
    for (const key of Object.keys(laneDistribution)) {
      delete laneDistribution[key];
    }
  };

  return (event: DelegationLifecycleEvent): void => {
    if (event.kind === 'delegation_started') {
      // Delegator session itself starting.
      if (event.agentName === 'delegator') {
        activeDelegatorSessionId = event.childSessionId;
        atomCounter = 0;
        for (const key of Object.keys(laneDistribution)) {
          delete laneDistribution[key];
        }
        opts.bus.publish({
          type: 'delegator_plan',
          seq: opts.bus.nextSeq(),
          sessionId: opts.rootSessionId,
        });
        return;
      }
      // Atom dispatched by the active delegator — only when the lifecycle
      // event carries a lane (cost-lane atoms have laneName from the
      // scheduler) AND the parent matches the active delegator.
      if (
        activeDelegatorSessionId !== null &&
        event.parentSessionId === activeDelegatorSessionId &&
        event.laneName !== null
      ) {
        const atomIndex = atomCounter;
        atomCounter += 1;
        atomIndexByChildSessionId.set(event.childSessionId, atomIndex);
        laneDistribution[event.laneName] = (laneDistribution[event.laneName] ?? 0) + 1;
        opts.bus.publish({
          type: 'delegator_atom_started',
          seq: opts.bus.nextSeq(),
          sessionId: opts.rootSessionId,
          atomIndex,
          laneName: event.laneName,
          promptPreview: previewPrompt(event.promptPreview),
          ...(event.laneProvider !== null ? { laneProvider: event.laneProvider } : {}),
          ...(event.laneModel !== null ? { laneModel: event.laneModel } : {}),
        });
        return;
      }
      // Any other delegation_started event (regular sub-agent calls, nested
      // delegators, dispatches before delegator started) is ignored.
      return;
    }

    // event.kind === 'delegation_completed'
    const atomIndex = atomIndexByChildSessionId.get(event.childSessionId);
    if (atomIndex !== undefined && event.laneName !== null) {
      opts.bus.publish({
        type: 'delegator_atom_complete',
        seq: opts.bus.nextSeq(),
        sessionId: opts.rootSessionId,
        atomIndex,
        laneName: event.laneName,
        success: event.success,
        durationMs: event.durationMs,
        ...(event.laneProvider !== null ? { laneProvider: event.laneProvider } : {}),
        ...(event.laneModel !== null ? { laneModel: event.laneModel } : {}),
      });
      atomIndexByChildSessionId.delete(event.childSessionId);
      return;
    }
    // Delegator session completing.
    if (event.childSessionId === activeDelegatorSessionId) {
      opts.bus.publish({
        type: 'delegator_complete',
        seq: opts.bus.nextSeq(),
        sessionId: opts.rootSessionId,
        totalAtomCount: atomCounter,
        laneDistribution: { ...laneDistribution },
      });
      resetDelegatorState();
      return;
    }
  };
}
