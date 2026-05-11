import { describe, expect, it } from 'bun:test';
import { initialUiState, reduce } from '../../../../src/ui/ink/state/reducer.js';
import type { UiEvent } from '../../../../src/ui/ink/state/types.js';

describe('ui reducer', () => {
  it('appends a user message on user_input_submitted', () => {
    const ev: UiEvent = { type: 'user_input_submitted', text: 'hi' };
    const next = reduce(initialUiState, ev);
    expect(next.transcript.length).toBe(1);
    const first = next.transcript[0];
    if (first === undefined || first.role !== 'user') {
      throw new Error(`expected user message, got ${first?.role ?? 'undefined'}`);
    }
    expect(first.role).toBe('user');
    expect(first.text).toBe('hi');
  });

  it('appends to current assistant message on assistant_text_delta', () => {
    const seeded = reduce(initialUiState, { type: 'user_input_submitted', text: 'hi' });
    const a1 = reduce(seeded, { type: 'assistant_text_delta', delta: 'Hello' });
    const a2 = reduce(a1, { type: 'assistant_text_delta', delta: ' world' });
    const assistantMsg = a2.transcript.at(-1);
    if (assistantMsg === undefined || assistantMsg.role !== 'assistant') {
      throw new Error(`expected assistant message, got ${assistantMsg?.role ?? 'undefined'}`);
    }
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.text).toBe('Hello world');
  });

  it('marks status idle/thinking on agent_turn_start/end', () => {
    let s = reduce(initialUiState, { type: 'agent_turn_start' });
    expect(s.status).toBe('thinking');
    s = reduce(s, { type: 'agent_turn_end' });
    expect(s.status).toBe('idle');
  });

  it('upserts task cards from task_update events', () => {
    const s1 = reduce(initialUiState, {
      type: 'task_update',
      taskId: 't1',
      state: 'queued',
    });
    expect(s1.tasks.t1?.state).toBe('queued');
    const s2 = reduce(s1, { type: 'task_update', taskId: 't1', state: 'completed' });
    expect(s2.tasks.t1?.state).toBe('completed');
  });
});
