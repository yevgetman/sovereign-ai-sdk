// Phase 2 T7 — `buildDelegatorProgressPayload(event)` is a thin JSON helper:
// verbatim serialization of the four delegator wire-event shapes so any
// SSE consumer sees the same payload the TUI / `sov drive` consumers see on
// the GET /events wire. Unit-tested here.
//
// FIX 5 — the OpenAI chat-completions streaming branch USED to subscribe the
// per-session bus and forward delegator_* events as
// `event: hermes.delegator.progress` side-channel frames. That path was dead
// code: the OpenAI route builds its ToolContext WITHOUT a
// delegationLifecycleRecorder, so nothing ever published those events on the
// OpenAI surface. The subscriber (and the two end-to-end tests that
// pre-seeded the bus to exercise it) were removed. `buildDelegatorProgressPayload`
// itself stays exported + used by the runtime's native /events surface, so
// its unit coverage remains here.

import { describe, expect, test } from 'bun:test';
import { buildDelegatorProgressPayload } from '../../../src/openai/streaming/chunks.js';

describe('buildDelegatorProgressPayload', () => {
  test('serializes delegator_plan event', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_plan',
      seq: 1,
      sessionId: 'root',
    });
    const parsed = JSON.parse(payload) as { type: string; sessionId: string };
    expect(parsed.type).toBe('delegator_plan');
    expect(parsed.sessionId).toBe('root');
  });

  test('serializes delegator_atom_started event', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_atom_started',
      seq: 2,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      promptPreview: 'list files',
    });
    const parsed = JSON.parse(payload) as {
      atomIndex: number;
      laneName: string;
      promptPreview: string;
    };
    expect(parsed.atomIndex).toBe(0);
    expect(parsed.laneName).toBe('cheap-task');
    expect(parsed.promptPreview).toBe('list files');
  });

  test('serializes delegator_atom_complete event', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_atom_complete',
      seq: 3,
      sessionId: 'root',
      atomIndex: 0,
      laneName: 'cheap-task',
      success: true,
      durationMs: 50,
    });
    const parsed = JSON.parse(payload) as { success: boolean; durationMs: number };
    expect(parsed.success).toBe(true);
    expect(parsed.durationMs).toBe(50);
  });

  test('serializes delegator_complete event with lane distribution', () => {
    const payload = buildDelegatorProgressPayload({
      type: 'delegator_complete',
      seq: 4,
      sessionId: 'root',
      totalAtomCount: 3,
      laneDistribution: { 'cheap-task': 2, 'moderate-task': 1 },
    });
    const parsed = JSON.parse(payload) as {
      totalAtomCount: number;
      laneDistribution: Record<string, number>;
    };
    expect(parsed.totalAtomCount).toBe(3);
    expect(parsed.laneDistribution['cheap-task']).toBe(2);
    expect(parsed.laneDistribution['moderate-task']).toBe(1);
  });
});
