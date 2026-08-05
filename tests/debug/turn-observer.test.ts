import { describe, expect, test } from 'bun:test';
import { createDebugCollector } from '../../packages/sdk/src/debug/collector.js';
import {
  createTurnObserver,
  summariseToolInput,
} from '../../packages/sdk/src/debug/turn-observer.js';
import type { TurnDetailEvent } from '../../packages/sdk/src/debug/types.js';

function harness() {
  const collector = createDebugCollector({ now: () => new Date('2026-08-04T10:00:00.000Z') });
  const observer = createTurnObserver({ sessionId: 's1', principal: 'acct-1', collector });
  // Oldest-first reads better for a stream assertion than the console's order.
  const details = (): TurnDetailEvent[] => [...collector.detailsFor('acct-1')].reverse();
  return { collector, observer, details };
}

describe('summariseToolInput', () => {
  test('prefers the human-meaningful field over raw JSON', () => {
    expect(summariseToolInput({ command: 'git status', timeout: 5000 })).toBe('git status');
    expect(summariseToolInput({ file_path: '/tmp/resume.json' })).toBe('/tmp/resume.json');
  });

  test('falls back to compact JSON when no field is meaningful', () => {
    expect(summariseToolInput({ alpha: 1 })).toBe('{"alpha":1}');
  });

  test('survives an unserialisable input rather than throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(summariseToolInput(cyclic)).toBe('');
  });

  test('caps long inputs', () => {
    expect(summariseToolInput({ command: 'x'.repeat(500) }).length).toBe(160);
  });

  test('handles the empty cases', () => {
    expect(summariseToolInput(null)).toBe('');
    expect(summariseToolInput(undefined)).toBe('');
    expect(summariseToolInput('literal')).toBe('literal');
  });
});

describe('tool name/input pairing', () => {
  test('pairs the name from START with the input from DONE', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'tool_use_start', seq: 1, block: 0, tool: 'Bash' });
    observer.observe({ type: 'tool_use_done', seq: 2, block: 0, input: { command: 'git log' } });

    expect(details()).toMatchObject([{ kind: 'tool_call', tool: 'Bash', input: 'git log' }]);
  });

  test('PAIRS BY BLOCK, so interleaved calls do not cross wires', () => {
    // The defect this guards: pairing by arrival order attributes the wrong
    // command to the wrong tool the moment two tools run concurrently.
    const { observer, details } = harness();

    observer.observe({ type: 'tool_use_start', seq: 1, block: 0, tool: 'Bash' });
    observer.observe({ type: 'tool_use_start', seq: 2, block: 1, tool: 'Read' });
    observer.observe({ type: 'tool_use_done', seq: 3, block: 1, input: { file_path: '/a.txt' } });
    observer.observe({ type: 'tool_use_done', seq: 4, block: 0, input: { command: 'ls' } });

    expect(details()).toMatchObject([
      { tool: 'Read', input: '/a.txt' },
      { tool: 'Bash', input: 'ls' },
    ]);
  });

  test('a DONE with no matching START still records something useful', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'tool_use_done', seq: 1, block: 7, input: { command: 'ls' } });

    expect(details()).toMatchObject([{ tool: 'tool', input: 'ls' }]);
  });
});

describe('reasoning blocks', () => {
  test('accumulates deltas into ONE row with an opening preview', () => {
    // Recording every delta floods the ring; recording only a count tells a
    // viewer nothing. One row per block, with the text, is the answer.
    const { observer, details } = harness();

    observer.observe({ type: 'thinking_delta', seq: 1, block: 0, text: 'The user wants ' });
    observer.observe({ type: 'thinking_delta', seq: 2, block: 0, text: 'a tailored resume.' });
    observer.observe({ type: 'text_delta', seq: 3, text: 'Sure.' });

    expect(details()).toMatchObject([
      { kind: 'thinking', chars: 33, preview: 'The user wants a tailored resume.' },
    ]);
  });

  test('a NEW BLOCK INDEX flushes the previous block', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'thinking_delta', seq: 1, block: 0, text: 'first' });
    observer.observe({ type: 'thinking_delta', seq: 2, block: 1, text: 'second' });
    observer.complete({ finishReason: 'end_turn', eventSeq: 3 });

    expect(details().filter((d) => d.kind === 'thinking')).toMatchObject([
      { preview: 'first' },
      { preview: 'second' },
    ]);
  });

  test('ANY non-thinking event ends the block', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'thinking_delta', seq: 1, block: 0, text: 'thinking' });
    observer.observe({ type: 'tool_use_start', seq: 2, block: 0, tool: 'Bash' });

    expect(details()[0]).toMatchObject({ kind: 'thinking', preview: 'thinking' });
  });

  test('an empty block produces no row', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'thinking_delta', seq: 1, block: 0, text: '' });
    observer.observe({ type: 'text_delta', seq: 2, text: 'hi' });

    expect(details()).toHaveLength(0);
  });
});

describe('turn summary', () => {
  test('counts tool calls, dedupes names, and carries the usage figures', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'tool_use_start', seq: 1, block: 0, tool: 'Bash' });
    observer.observe({ type: 'tool_use_done', seq: 2, block: 0, input: { command: 'ls' } });
    observer.observe({ type: 'tool_use_start', seq: 3, block: 1, tool: 'Bash' });
    observer.observe({ type: 'tool_use_done', seq: 4, block: 1, input: { command: 'pwd' } });
    observer.observe({ type: 'thinking_delta', seq: 5, block: 2, text: 'hmm' });
    observer.observe({ type: 'text_delta', seq: 6, text: 'done' });
    observer.observe({ type: 'status_update', seq: 7, tokensIn: 120, tokensOut: 40, cost: 0.0031 });
    observer.complete({ finishReason: 'end_turn', eventSeq: 8 });

    expect(details().at(-1)).toMatchObject({
      kind: 'turn_end',
      finishReason: 'end_turn',
      toolCalls: 2,
      tools: ['Bash'],
      thinkingChars: 3,
      textChars: 4,
      tokensIn: 120,
      tokensOut: 40,
      cost: 0.0031,
    });
  });

  test('flushes open reasoning before the summary', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'thinking_delta', seq: 1, block: 0, text: 'still thinking' });
    observer.complete({ finishReason: 'end_turn', eventSeq: 2 });

    expect(details().map((d) => d.kind)).toEqual(['thinking', 'turn_end']);
  });

  test('a failure flushes reasoning and records the error, capped', () => {
    const { observer, details } = harness();

    observer.observe({ type: 'thinking_delta', seq: 1, block: 0, text: 'hmm' });
    observer.fail('x'.repeat(500), 2);

    const rows = details();
    expect(rows.map((d) => d.kind)).toEqual(['thinking', 'turn_error']);
    expect((rows[1] as { error: string }).error.length).toBe(160);
  });

  test('OBSERVATION NEVER BREAKS THE STREAM IT OBSERVES', () => {
    const observer = createTurnObserver({
      sessionId: 's1',
      principal: 'acct-1',
      // Only `recordDetail` — the observer's contract is narrowed to the one
      // method it calls, so this is all a host has to supply.
      collector: {
        recordDetail: () => {
          throw new Error('ring exploded');
        },
      },
    });

    expect(() =>
      observer.observe({ type: 'tool_use_done', seq: 1, block: 0, input: {} }),
    ).not.toThrow();
    expect(() => observer.complete({ finishReason: 'end_turn', eventSeq: 2 })).not.toThrow();
    expect(() => observer.fail('boom', 3)).not.toThrow();
  });
});
