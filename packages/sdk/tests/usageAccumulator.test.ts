// Task 4.2 — unit tests for the open cross-call usage accumulator
// (packages/sdk/src/core/usageAccumulator.ts).
//
// Semantics under test (the tool-loop token model):
//   • Within ONE provider call, `usage_delta` events are CUMULATIVE-FROM-ZERO —
//     keep the LAST-SEEN value PER FIELD (a later delta that omits a field does
//     not clear the earlier value).
//   • Across calls, SUM the per-call finals. A new provider call begins at each
//     `message_start` (which flushes the prior call); `finalizeUsage` flushes
//     the trailing call once more at stream end.
//   • Field-absence: a field NO call ever reported stays ABSENT from the total
//     (no zero fabrication — recordTokenUsage/estimateCostUsd see exactly the
//     fields the provider reported, like the single-call path always did). A
//     field absent in SOME calls is treated as 0 for those calls only.
//   • A run with NO usage_delta finalizes to `undefined` (recordTokenUsage is
//     skipped — byte-identical to the old latest-snapshot path).
//
// The module is internal (NOT barrel-exported): imported via the deep subpath.

import { describe, expect, test } from 'bun:test';
import type { StreamEvent } from '@yevgetman/sov-sdk/core/types';
import {
  type UsageAccumulator,
  accumulateUsage,
  createUsageAccumulator,
  finalizeUsage,
} from '@yevgetman/sov-sdk/core/usageAccumulator';

/** Fold a whole event sequence, mirroring createAgent's drive loop. */
function feed(events: StreamEvent[]): UsageAccumulator {
  let acc = createUsageAccumulator();
  for (const ev of events) acc = accumulateUsage(acc, ev);
  return acc;
}

describe('usageAccumulator', () => {
  test('within one call, cumulative deltas keep the LAST-SEEN value (not a sum)', () => {
    const acc = feed([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 9 } },
    ]);
    expect(finalizeUsage(acc)).toEqual({ inputTokens: 12, outputTokens: 9 });
  });

  test('across calls, per-call finals are SUMMED (message_start flushes; finalize flushes the trailing call)', () => {
    const acc = feed([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 9 } },
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 7, outputTokens: 3 } },
      { type: 'usage_delta', usage: { inputTokens: 8, outputTokens: 4 } },
    ]);
    // 12+8 / 9+4 — NOT the last snapshot (8/4), NOT the naive delta-sum (37/21).
    expect(finalizeUsage(acc)).toEqual({ inputTokens: 20, outputTokens: 13 });
  });

  test('last-seen is tracked PER FIELD — a later delta omitting a field does not clear it', () => {
    const acc = feed([
      { type: 'message_start' },
      // Anthropic shape: message_start delta carries input + cache fields...
      { type: 'usage_delta', usage: { inputTokens: 10, cacheReadInputTokens: 40 } },
      // ...message_delta carries the final cumulative output (no cache fields).
      { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 9 } },
    ]);
    expect(finalizeUsage(acc)).toEqual({
      inputTokens: 12,
      outputTokens: 9,
      cacheReadInputTokens: 40,
    });
  });

  test('a field reported by only SOME calls sums correctly (absent-as-0 for the others), and a field NO call reported stays absent', () => {
    const acc = feed([
      { type: 'message_start' },
      {
        type: 'usage_delta',
        usage: { inputTokens: 12, outputTokens: 9, cacheReadInputTokens: 40 },
      },
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 8, outputTokens: 4 } },
    ]);
    const total = finalizeUsage(acc);
    expect(total).toEqual({ inputTokens: 20, outputTokens: 13, cacheReadInputTokens: 40 });
    // No zero fabrication: cacheCreationInputTokens was never reported → absent.
    expect(total !== undefined && 'cacheCreationInputTokens' in total).toBe(false);
  });

  test('no usage_delta at all → finalize returns undefined (recordTokenUsage stays skipped)', () => {
    const acc = feed([
      { type: 'message_start' },
      { type: 'text_delta', text: 'hi' },
      { type: 'message_stop', stop_reason: 'end_turn' },
    ]);
    expect(finalizeUsage(acc)).toBeUndefined();
  });

  test('an empty usage object still counts as reported usage → finalize returns {} (matches the old latest-snapshot semantics)', () => {
    const acc = feed([{ type: 'message_start' }, { type: 'usage_delta', usage: {} }]);
    expect(finalizeUsage(acc)).toEqual({});
  });

  test('non-usage events are no-ops (same state back)', () => {
    const acc = feed([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 1 } },
    ]);
    const after = accumulateUsage(acc, { type: 'text_delta', text: 'x' });
    expect(after).toBe(acc);
  });

  test('a usage_delta BEFORE any message_start still lands in the current call (defensive ordering)', () => {
    const acc = feed([{ type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 2 } }]);
    expect(finalizeUsage(acc)).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  test('accumulate + finalize never mutate their input (immutability)', () => {
    const acc = feed([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const snapshot = JSON.parse(JSON.stringify(acc));
    accumulateUsage(acc, { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 9 } });
    accumulateUsage(acc, { type: 'message_start' });
    finalizeUsage(acc);
    expect(JSON.parse(JSON.stringify(acc))).toEqual(snapshot);
  });

  test('finalize is idempotent — calling it twice on the same state returns the same total', () => {
    const acc = feed([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
    expect(finalizeUsage(acc)).toEqual(finalizeUsage(acc));
    expect(finalizeUsage(acc)).toEqual({ inputTokens: 17, outputTokens: 8 });
  });

  // F23: message_stop is ALSO a per-call flush boundary. A custom provider that
  // emits usage_delta + message_stop per call but NO message_start must still
  // SUM every call's tokens, not report only the last call.
  test('message_stop flushes the call — a provider that omits message_start still SUMS all calls', () => {
    const acc = feed([
      { type: 'usage_delta', usage: { inputTokens: 100, outputTokens: 50 } },
      { type: 'message_stop', stop_reason: 'tool_use' },
      { type: 'usage_delta', usage: { inputTokens: 120, outputTokens: 60 } },
      { type: 'message_stop', stop_reason: 'end_turn' },
    ]);
    // Without a message_stop flush, call 2 would overwrite call 1 and the total
    // would be only the last call (120/60). It must be the sum.
    expect(finalizeUsage(acc)).toEqual({ inputTokens: 220, outputTokens: 110 });
  });

  // F23 regression: with BOTH message_start and message_stop present (the normal
  // Anthropic shape once message_stop is emitted), the redundant flush is a safe
  // no-op — the total is still the plain sum, never double-counted.
  test('message_start + message_stop together do not double-count (redundant flush is a no-op)', () => {
    const acc = feed([
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'message_stop', stop_reason: 'tool_use' },
      { type: 'message_start' },
      { type: 'usage_delta', usage: { inputTokens: 7, outputTokens: 3 } },
      { type: 'message_stop', stop_reason: 'end_turn' },
    ]);
    expect(finalizeUsage(acc)).toEqual({ inputTokens: 17, outputTokens: 8 });
  });
});
