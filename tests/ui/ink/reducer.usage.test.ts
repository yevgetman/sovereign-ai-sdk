import { describe, expect, test } from 'bun:test';
import { initialUiState, reduce } from '../../../src/ui/ink/state/reducer.js';

describe('reducer — usage_delta', () => {
  test('accumulates input + output tokens', () => {
    const after = reduce(initialUiState, {
      type: 'usage_delta',
      delta: { inputTokens: 100, outputTokens: 50 },
      estimatedUsdDelta: 0.01,
    });
    expect(after.sessionCost.inputTokens).toBe(100);
    expect(after.sessionCost.outputTokens).toBe(50);
    expect(after.sessionCost.estimatedUsd).toBeCloseTo(0.01, 5);
  });

  test('two deltas accumulate', () => {
    const a = reduce(initialUiState, {
      type: 'usage_delta',
      delta: { inputTokens: 100 },
      estimatedUsdDelta: 0.01,
    });
    const b = reduce(a, {
      type: 'usage_delta',
      delta: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 10 },
      estimatedUsdDelta: 0.02,
    });
    expect(b.sessionCost.inputTokens).toBe(150);
    expect(b.sessionCost.outputTokens).toBe(30);
    expect(b.sessionCost.cacheReadTokens).toBe(10);
    expect(b.sessionCost.estimatedUsd).toBeCloseTo(0.03, 5);
  });
});

describe('reducer — transcript_cleared', () => {
  test('resets transcript and sessionCost', () => {
    const seeded = reduce(initialUiState, { type: 'user_input_submitted', text: 'hi' });
    const billed = reduce(seeded, {
      type: 'usage_delta',
      delta: { inputTokens: 100 },
      estimatedUsdDelta: 0.05,
    });
    expect(billed.transcript.length).toBe(1);
    expect(billed.sessionCost.estimatedUsd).toBeCloseTo(0.05, 5);

    const cleared = reduce(billed, { type: 'transcript_cleared' });
    expect(cleared.transcript).toEqual([]);
    expect(cleared.sessionCost.estimatedUsd).toBe(0);
  });
});

describe('reducer — command_output', () => {
  test('appends command_output transcript message', () => {
    const after = reduce(initialUiState, { type: 'command_output', text: 'help text' });
    expect(after.transcript).toHaveLength(1);
    expect(after.transcript[0]).toEqual({ role: 'command_output', text: 'help text' });
  });
});
