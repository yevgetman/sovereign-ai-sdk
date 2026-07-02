// Phase 2 T4 — Unit tests for the runtime-synthesized delegator SSE events.
//
// Covers two concerns:
//   1. Wire-event schemas parse the expected shapes (mirrors the TUI / drive
//      consumers that re-parse the JSON envelope).
//   2. The `synthesizeDelegationEvents` closure correctly maps the scheduler's
//      delegation lifecycle into the four delegator_* events, including the
//      ignore-non-router-children edge case the spec calls out.
//
// Plan: docs/plans/2026-05-23-phase-2-task-routing.md (T4)
// Spec: docs/specs/2026-05-23-multi-provider-task-routing-design.md

import { describe, expect, test } from 'bun:test';
import type { AgentRegistry } from '@yevgetman/sov-sdk/agents/types';
import {
  DelegatorAtomCompleteEventSchema,
  DelegatorAtomStartedEventSchema,
  DelegatorCompleteEventSchema,
  DelegatorPlanEventSchema,
  synthesizeDelegationEvents,
} from '../../src/router/progressEvents.js';
import type { ServerEventBus } from '../../src/server/eventBus.js';

/** Minimal bus stub matching the surface synthesizeDelegationEvents reads
 *  (publish + nextSeq). Recording into a captured array keeps test setup
 *  contained without spinning up a real `ServerEventBus`. */
function makeStubBus(): { bus: ServerEventBus; events: unknown[] } {
  const events: unknown[] = [];
  const bus = {
    publish: (event: unknown): void => {
      events.push(event);
    },
    nextSeq: (): number => events.length + 1,
  } as unknown as ServerEventBus;
  return { bus, events };
}

/** Empty AgentRegistry stub — the closure carries the reference for future
 *  surface extensions; it doesn't read it today. */
const EMPTY_REGISTRY: AgentRegistry = {
  agents: [],
  byName: new Map(),
};

describe('delegator event Zod schemas', () => {
  test('DelegatorPlanEventSchema parses a minimal event without scheduledAtomCount', () => {
    const parsed = DelegatorPlanEventSchema.parse({
      type: 'delegator_plan',
      seq: 1,
      sessionId: 'root-session',
    });
    expect(parsed.type).toBe('delegator_plan');
    expect(parsed.seq).toBe(1);
    expect(parsed.scheduledAtomCount).toBeUndefined();
  });

  test('DelegatorPlanEventSchema accepts scheduledAtomCount when present', () => {
    const parsed = DelegatorPlanEventSchema.parse({
      type: 'delegator_plan',
      seq: 1,
      sessionId: 'root',
      scheduledAtomCount: 3,
    });
    expect(parsed.scheduledAtomCount).toBe(3);
  });

  test('DelegatorAtomStartedEventSchema requires every field', () => {
    expect(() =>
      DelegatorAtomStartedEventSchema.parse({
        type: 'delegator_atom_started',
        seq: 1,
        sessionId: 'root',
        atomIndex: 0,
        laneName: 'cheap-task',
        // promptPreview missing — must throw
      }),
    ).toThrow();
  });

  test('DelegatorAtomStartedEventSchema parses a full event', () => {
    const parsed = DelegatorAtomStartedEventSchema.parse({
      type: 'delegator_atom_started',
      seq: 2,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      promptPreview: 'do the trivial thing',
    });
    expect(parsed.atomIndex).toBe(0);
    expect(parsed.laneName).toBe('cheap-task');
    expect(parsed.promptPreview).toBe('do the trivial thing');
  });

  test('DelegatorAtomCompleteEventSchema parses success=true', () => {
    const parsed = DelegatorAtomCompleteEventSchema.parse({
      type: 'delegator_atom_complete',
      seq: 3,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      success: true,
      durationMs: 100,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.durationMs).toBe(100);
  });

  test('DelegatorAtomCompleteEventSchema parses success=false', () => {
    const parsed = DelegatorAtomCompleteEventSchema.parse({
      type: 'delegator_atom_complete',
      seq: 3,
      sessionId: 'root',
      atomIndex: 1,
      laneName: 'moderate-task',
      success: false,
      durationMs: 5000,
    });
    expect(parsed.success).toBe(false);
  });

  test('DelegatorCompleteEventSchema accepts an empty lane distribution', () => {
    const parsed = DelegatorCompleteEventSchema.parse({
      type: 'delegator_complete',
      seq: 4,
      sessionId: 'root',
      totalAtomCount: 0,
      laneDistribution: {},
    });
    expect(parsed.totalAtomCount).toBe(0);
    expect(parsed.laneDistribution).toEqual({});
  });

  test('DelegatorCompleteEventSchema parses a richer lane distribution', () => {
    const parsed = DelegatorCompleteEventSchema.parse({
      type: 'delegator_complete',
      seq: 4,
      sessionId: 'root',
      totalAtomCount: 3,
      laneDistribution: { 'cheap-task': 1, 'moderate-task': 2 },
    });
    expect(parsed.totalAtomCount).toBe(3);
    expect(parsed.laneDistribution['cheap-task']).toBe(1);
    expect(parsed.laneDistribution['moderate-task']).toBe(2);
  });
});

describe('synthesizeDelegationEvents closure — state machine', () => {
  test('publishes delegator_plan when the delegator starts', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg-child',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'do task',
    });
    expect(events).toHaveLength(1);
    const first = events[0] as { type: string; sessionId: string };
    expect(first.type).toBe('delegator_plan');
    expect(first.sessionId).toBe('root');
  });

  test('emits the full atom_started → atom_complete → delegator_complete sequence for one atom', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    // 1. Delegator dispatch.
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg-child',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'task',
    });
    // 2. Atom dispatch by delegator.
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg-child',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'list files',
    });
    // 3. Atom completion.
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg-child',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      success: true,
      durationMs: 50,
    });
    // 4. Delegator completion.
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'deleg-child',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      success: true,
      durationMs: 100,
    });
    expect(events).toHaveLength(4);
    const plan = events[0] as { type: string };
    const atomStarted = events[1] as { type: string; atomIndex: number; laneName: string };
    const atomCompleted = events[2] as {
      type: string;
      atomIndex: number;
      success: boolean;
      durationMs: number;
    };
    const delegatorCompleted = events[3] as {
      type: string;
      totalAtomCount: number;
      laneDistribution: Record<string, number>;
    };
    expect(plan.type).toBe('delegator_plan');
    expect(atomStarted.type).toBe('delegator_atom_started');
    expect(atomStarted.atomIndex).toBe(0);
    expect(atomStarted.laneName).toBe('cheap-task');
    expect(atomCompleted.type).toBe('delegator_atom_complete');
    expect(atomCompleted.atomIndex).toBe(0);
    expect(atomCompleted.success).toBe(true);
    expect(atomCompleted.durationMs).toBe(50);
    expect(delegatorCompleted.type).toBe('delegator_complete');
    expect(delegatorCompleted.totalAtomCount).toBe(1);
    expect(delegatorCompleted.laneDistribution['cheap-task']).toBe(1);
  });

  // 2026-05-24 patch — laneProvider/laneModel flow through to the wire.
  test('laneProvider and laneModel propagate from recorder to wire events', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg-child',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'do task',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg-child',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: 'anthropic',
      laneModel: 'claude-haiku-4-5-20251001',
      promptPreview: 'tiny task',
    });
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg-child',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: 'anthropic',
      laneModel: 'claude-haiku-4-5-20251001',
      success: true,
      durationMs: 42,
    });

    // events[0] = plan; events[1] = atom_started; events[2] = atom_complete.
    const atomStarted = events[1] as {
      type: string;
      laneName: string;
      laneProvider?: string;
      laneModel?: string;
    };
    const atomComplete = events[2] as {
      type: string;
      laneName: string;
      laneProvider?: string;
      laneModel?: string;
    };
    expect(atomStarted.laneProvider).toBe('anthropic');
    expect(atomStarted.laneModel).toBe('claude-haiku-4-5-20251001');
    expect(atomComplete.laneProvider).toBe('anthropic');
    expect(atomComplete.laneModel).toBe('claude-haiku-4-5-20251001');
  });

  test('null laneProvider / laneModel are omitted from the wire event', () => {
    // When the scheduler couldn't resolve the lane (laneProvider/Model
    // are null), the wire event simply omits those fields. Consumers
    // that didn't opt into debug mode never see them anyway.
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg-child',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'do task',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg-child',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'tiny task',
    });
    const atomStarted = events[1] as Record<string, unknown>;
    expect(atomStarted.laneProvider).toBeUndefined();
    expect(atomStarted.laneModel).toBeUndefined();
  });

  test('assigns increasing atomIndex values across multiple atom dispatches', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'multi',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'a',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-2',
      parentSessionId: 'deleg',
      agentName: 'moderate-task',
      laneName: 'moderate-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'b',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-3',
      parentSessionId: 'deleg',
      agentName: 'frontier-task',
      laneName: 'frontier-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'c',
    });
    // delegator_plan + three atom_started = 4 events.
    expect(events).toHaveLength(4);
    const a1 = events[1] as { atomIndex: number };
    const a2 = events[2] as { atomIndex: number };
    const a3 = events[3] as { atomIndex: number };
    expect(a1.atomIndex).toBe(0);
    expect(a2.atomIndex).toBe(1);
    expect(a3.atomIndex).toBe(2);
  });

  test('atom completion uses the SAME atomIndex assigned at dispatch', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p1',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-2',
      parentSessionId: 'deleg',
      agentName: 'moderate-task',
      laneName: 'moderate-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p2',
    });
    // Complete out of dispatch order — completion still uses dispatch index.
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'atom-2',
      parentSessionId: 'deleg',
      agentName: 'moderate-task',
      laneName: 'moderate-task',
      laneProvider: null,
      laneModel: null,
      success: true,
      durationMs: 200,
    });
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      success: true,
      durationMs: 50,
    });
    // delegator_plan + 2 atom_started + 2 atom_complete = 5
    expect(events).toHaveLength(5);
    const comp1 = events[3] as { atomIndex: number; laneName: string };
    const comp2 = events[4] as { atomIndex: number; laneName: string };
    expect(comp1.atomIndex).toBe(1); // atom-2 dispatched second
    expect(comp1.laneName).toBe('moderate-task');
    expect(comp2.atomIndex).toBe(0); // atom-1 dispatched first
    expect(comp2.laneName).toBe('cheap-task');
  });

  test('records lane distribution across mixed-lane atoms', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-a',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'a',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-b',
      parentSessionId: 'deleg',
      agentName: 'moderate-task',
      laneName: 'moderate-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'b',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-c',
      parentSessionId: 'deleg',
      agentName: 'moderate-task',
      laneName: 'moderate-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'c',
    });
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      success: true,
      durationMs: 500,
    });
    // delegator_plan + 3 atom_started + delegator_complete (no per-atom
    // completions in this trace — testing distribution accounting only)
    expect(events).toHaveLength(5);
    const delegatorCompleted = events[4] as {
      type: string;
      totalAtomCount: number;
      laneDistribution: Record<string, number>;
    };
    expect(delegatorCompleted.type).toBe('delegator_complete');
    expect(delegatorCompleted.totalAtomCount).toBe(3);
    expect(delegatorCompleted.laneDistribution).toEqual({
      'cheap-task': 1,
      'moderate-task': 2,
    });
  });

  test('ignores delegations that are NOT children of the active delegator', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    // explore is a regular domain agent dispatched by the parent directly —
    // not an atom under the delegator. laneName is null because no router
    // lane was resolved.
    recorder({
      kind: 'delegation_started',
      childSessionId: 'explore-child',
      parentSessionId: 'root',
      agentName: 'explore',
      laneName: null,
      laneProvider: null,
      laneModel: null,
      promptPreview: 'find files',
    });
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'explore-child',
      parentSessionId: 'root',
      agentName: 'explore',
      laneName: null,
      laneProvider: null,
      laneModel: null,
      success: true,
      durationMs: 30,
    });
    // No delegator started, no laneName on the dispatch — closure must
    // emit nothing.
    expect(events).toHaveLength(0);
  });

  test('atom dispatch whose parent does NOT match the active delegator is ignored', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p',
    });
    // This dispatch has parentSessionId !== deleg (the active delegator) so
    // it must be ignored even though it carries a laneName.
    recorder({
      kind: 'delegation_started',
      childSessionId: 'foreign-atom',
      parentSessionId: 'some-other-parent',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'x',
    });
    // Only the delegator_plan event should have been published.
    expect(events).toHaveLength(1);
  });

  test('atom dispatch with null laneName is ignored even under the active delegator', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p',
    });
    // No laneName — closure must not emit an atom_started event.
    recorder({
      kind: 'delegation_started',
      childSessionId: 'foo-child',
      parentSessionId: 'deleg',
      agentName: 'explore',
      laneName: null,
      laneProvider: null,
      laneModel: null,
      promptPreview: 'x',
    });
    expect(events).toHaveLength(1); // only the delegator_plan
  });

  test('truncates promptPreview to 80 chars with ellipsis', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p',
    });
    const longPrompt = 'a'.repeat(200);
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: longPrompt,
    });
    const atomEvent = events[1] as { promptPreview: string };
    expect(atomEvent.promptPreview.length).toBe(80);
    expect(atomEvent.promptPreview.endsWith('…')).toBe(true);
  });

  test('preserves short promptPreview unchanged', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'short prompt',
    });
    const atomEvent = events[1] as { promptPreview: string };
    expect(atomEvent.promptPreview).toBe('short prompt');
  });

  test('failed atom emits atom_complete with success=false', () => {
    const { bus, events } = makeStubBus();
    const recorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: 'root',
      agentRegistry: EMPTY_REGISTRY,
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'deleg',
      parentSessionId: 'root',
      agentName: 'delegator',
      laneName: 'delegator',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p',
    });
    recorder({
      kind: 'delegation_started',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      promptPreview: 'p1',
    });
    recorder({
      kind: 'delegation_completed',
      childSessionId: 'atom-1',
      parentSessionId: 'deleg',
      agentName: 'cheap-task',
      laneName: 'cheap-task',
      laneProvider: null,
      laneModel: null,
      success: false,
      durationMs: 999,
    });
    const completeEvent = events[2] as { success: boolean; durationMs: number };
    expect(completeEvent.success).toBe(false);
    expect(completeEvent.durationMs).toBe(999);
  });
});
