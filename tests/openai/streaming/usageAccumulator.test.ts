// Findings #18 + #38 — unit tests for the shared usage accumulator.
//
// #18: the per-call accumulation must include cache-read AND cache-creation
//      tokens in prompt_tokens / total_tokens. Anthropic's usageToInternal
//      maps input_tokens WITHOUT cached tokens, so a cache hit (the default
//      path within a tool loop) understated the totals by an order of
//      magnitude before this fix.
// #38: the same accumulation drives the streaming branch's final usage chunk
//      for parity with the non-streaming totals.

import { describe, expect, test } from 'bun:test';
import {
  accumulateUsageEvent,
  buildUsageChunk,
  createUsageAccumulator,
  finalizeUsage,
} from '../../../src/openai/streaming/chunks.js';

/** Fold a sequence of events through the accumulator and finalize. */
function run(events: unknown[]): ReturnType<typeof finalizeUsage> {
  let acc = createUsageAccumulator();
  for (const ev of events) acc = accumulateUsageEvent(acc, ev);
  return finalizeUsage(acc);
}

describe('usage accumulator', () => {
  test('zero-call run reports all-zero usage', () => {
    expect(run([])).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  test('single call with plain input/output sums correctly', () => {
    const usage = run([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 300 } },
      { type: 'usage_delta', usage: { outputTokens: 50 } },
      { type: 'message_stop' },
    ]);
    expect(usage).toEqual({ prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 });
  });

  // #18 — the regression case. A cache hit reports 300 fresh input + 20000
  // cache-read tokens. Before the fix prompt_tokens was 300; it must be 20300.
  test('includes cache-read tokens in prompt_tokens and total_tokens (#18)', () => {
    const usage = run([
      { type: 'message_start' },
      {
        type: 'usage_delta',
        usage: { inputTokens: 300, cacheReadInputTokens: 20000, outputTokens: 80 },
      },
      { type: 'message_stop' },
    ]);
    expect(usage.prompt_tokens).toBe(20300);
    expect(usage.completion_tokens).toBe(80);
    expect(usage.total_tokens).toBe(20380);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 20000 });
  });

  test('includes cache-creation tokens in prompt_tokens (#18)', () => {
    const usage = run([
      { type: 'message_start' },
      {
        type: 'usage_delta',
        usage: { inputTokens: 100, cacheCreationInputTokens: 5000, outputTokens: 10 },
      },
      { type: 'message_stop' },
    ]);
    expect(usage.prompt_tokens).toBe(5100);
    expect(usage.total_tokens).toBe(5110);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 5000 });
  });

  test('sums cache tokens across calls in a tool loop (#18)', () => {
    // Call 1: 500 fresh input (no cache, cache-creation) + 40 out.
    // Call 2: 200 fresh + 20000 cache-read + 30 out (the cache hit).
    const usage = run([
      { type: 'message_start' },
      {
        type: 'usage_delta',
        usage: { inputTokens: 500, cacheCreationInputTokens: 0, outputTokens: 40 },
      },
      { type: 'message_stop' },
      { type: 'message_start' },
      {
        type: 'usage_delta',
        usage: { inputTokens: 200, cacheReadInputTokens: 20000, outputTokens: 30 },
      },
      { type: 'message_stop' },
    ]);
    // prompt: 500 + (200 + 20000) = 20700; completion: 40 + 30 = 70.
    expect(usage.prompt_tokens).toBe(20700);
    expect(usage.completion_tokens).toBe(70);
    expect(usage.total_tokens).toBe(20770);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 20000 });
  });

  test('keeps last-seen value per field within a single call (no double-count)', () => {
    // Two deltas in one call: message_start carries input, message_delta the
    // final cumulative output. They must NOT both add to the same field.
    const usage = run([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 1000, cacheReadInputTokens: 7000 } },
      {
        type: 'usage_delta',
        usage: { inputTokens: 1000, cacheReadInputTokens: 7000, outputTokens: 60 },
      },
      { type: 'message_stop' },
    ]);
    expect(usage.prompt_tokens).toBe(8000);
    expect(usage.completion_tokens).toBe(60);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 7000 });
  });

  test('omits prompt_tokens_details when no cached tokens observed', () => {
    const usage = run([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 42, outputTokens: 7 } },
      { type: 'message_stop' },
    ]);
    expect(usage.prompt_tokens_details).toBeUndefined();
  });

  test('ignores unrelated and malformed events', () => {
    const usage = run([
      { type: 'message_start' },
      { type: 'text_delta', text: 'hi' },
      { type: 'usage_delta' }, // no usage field — skipped
      { type: 'usage_delta', usage: null }, // malformed — skipped
      { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 2 } },
      'not an object',
      null,
      { type: 'message_stop' },
    ]);
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  test('accumulator is immutable (fold returns new state)', () => {
    const a = createUsageAccumulator();
    const b = accumulateUsageEvent(a, { type: 'message_start' });
    expect(a.sawAnyCall).toBe(false);
    expect(b.sawAnyCall).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('buildUsageChunk (#38)', () => {
  const ctx = { id: 'chatcmpl-x', model: 'harness-default', created: 1700000000 };

  test('emits a chat.completion.chunk with empty choices and the usage object', () => {
    const chunk = buildUsageChunk(
      { prompt_tokens: 20300, completion_tokens: 80, total_tokens: 20380 },
      ctx,
    );
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices).toEqual([]);
    expect(chunk.usage.prompt_tokens).toBe(20300);
    expect(chunk.usage.total_tokens).toBe(20380);
    expect(chunk.id).toBe('chatcmpl-x');
  });
});
