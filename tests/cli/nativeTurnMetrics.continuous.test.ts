import { expect, test } from 'bun:test';
import {
  type NativeReceipt,
  appendNativeReceipt,
  nativeTurnMetrics,
} from '../../src/cli/nativeTurnMetrics.js';

test('continuous telemetry keeps bounded receipts and exact aggregate usage/cost', () => {
  const receipts: NativeReceipt[] = [];
  for (let index = 0; index < 10005; index++) {
    appendNativeReceipt(receipts, {
      usage: { inputTokens: 3, outputTokens: 2 },
      costEstimate: {
        scope: 'provider',
        provider: 'fixture',
        model: 'fixture',
        source: 'fixture',
        version: 1,
        pricedAt: '2026-10-25T00:00:00Z',
        state: 'paid',
        complete: true,
        amountUsd: 0.01,
      },
    });
    expect(receipts.length).toBeLessThanOrEqual(64);
  }
  const result = nativeTurnMetrics(receipts);
  expect(result.usage).toEqual({ inputTokens: 30015, outputTokens: 20010 });
  expect(result.estimatedCostUsd).toBeCloseTo(100.05, 8);
  expect(JSON.stringify(result).length).toBeLessThan(30000);
});
