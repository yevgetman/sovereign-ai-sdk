import { expect, test } from 'bun:test';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/index';
import { estimateUsageCost, pricingSnapshotForModel } from '@yevgetman/sov-sdk/providers/pricing';
import { nativeTurnMetrics, nativeUsageMeter } from '../../src/cli/nativeTurnMetrics.js';
const metadata: ModelRecord = {
  id: 'fixture',
  displayName: 'Fixture',
  provider: 'openai',
  routeId: 'openai-api',
  auth: 'api_key',
  availability: 'unknown',
  capabilities: {
    textOutput: 'supported',
    images: 'unsupported',
    tools: 'supported',
    reasoning: 'unsupported',
  },
  metadata: { source: 'fixture', stale: false },
  pricing: {
    currency: 'USD',
    source: 'fixture',
    state: 'paid',
    inputPerMillion: 2,
    outputPerMillion: 8,
  },
};

test('native bill adds three measured operations and retains their individual evidence', () => {
  const receipts = [
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 70, outputTokens: 12 },
    { inputTokens: 30, outputTokens: 8 },
  ].map((usage) => ({
    usage,
    costEstimate: estimateUsageCost('openai', 'fixture', usage, pricingSnapshotForModel(metadata)),
  }));
  const total = nativeTurnMetrics(receipts);
  expect(total.usage).toEqual({ inputTokens: 200, outputTokens: 30 });
  expect(total.costEstimate).toMatchObject({ complete: true, state: 'paid' });
  expect(total.estimatedCostUsd).toBeCloseTo(0.00064, 10);
  expect(total.costEstimate?.components?.map((part) => part.usage)).toEqual(
    receipts.map((part) => part.usage),
  );
});

test('a partial failed call keeps known tokens while refusing an invented complete cost', () => {
  const meter = nativeUsageMeter('openai', 'fixture', metadata);
  meter.observe({ type: 'message_start' });
  meter.observe({ type: 'usage_delta', usage: { inputTokens: 100 } });
  const usage = { inputTokens: 70, outputTokens: 12 };
  const total = nativeTurnMetrics([
    meter.partial(),
    {
      usage,
      costEstimate: estimateUsageCost(
        'openai',
        'fixture',
        usage,
        pricingSnapshotForModel(metadata),
      ),
    },
  ]);
  expect(total.usage).toEqual({ inputTokens: 170, outputTokens: 12 });
  expect(total.costEstimate).toMatchObject({ complete: false, state: 'unknown' });
  expect(total.estimatedCostUsd).toBeUndefined();
  expect(total.costEstimate?.components?.[1]?.amountUsd).toBeCloseTo(0.000236, 10);
});

test('subscription calls keep subscription provenance without a fabricated API cost or token zero', () => {
  const record: ModelRecord = { ...metadata, auth: 'subscription', pricing: undefined };
  const meter = nativeUsageMeter('openai', 'fixture', record);
  const total = nativeTurnMetrics([meter.partial()]);
  expect(total.usage).toBeUndefined();
  expect(total.costEstimate).toMatchObject({ state: 'subscription', complete: false });
  expect(total.costEstimate?.amountUsd).toBeUndefined();
  expect(total.estimatedCostUsd).toBeUndefined();
});
