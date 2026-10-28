/** Native host receipts span main drives and same-route summary requests. */
import type { StreamEvent, TokenUsage } from '@yevgetman/sov-sdk/core/types';
import {
  accumulateUsage,
  createUsageAccumulator,
  finalizeUsage,
} from '@yevgetman/sov-sdk/core/usageAccumulator';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/index';
import {
  type CostEstimate,
  estimateUsageCost,
  pricingSnapshotForModel,
} from '@yevgetman/sov-sdk/providers/pricing';

export type NativeReceipt = { usage?: TokenUsage; costEstimate?: CostEstimate };
export function nativeUsageMeter(provider: string, model: string, metadata: ModelRecord) {
  let acc = createUsageAccumulator();
  return {
    observe(event: StreamEvent) {
      acc = accumulateUsage(acc, event);
    },
    partial(): NativeReceipt {
      const usage = finalizeUsage(acc);
      const estimate = estimateUsageCost(
        provider,
        model,
        usage ?? {},
        pricingSnapshotForModel(metadata),
      );
      const { amountUsd: _amount, ...receipt } = estimate;
      return {
        ...(usage ? { usage } : {}),
        costEstimate: {
          ...receipt,
          complete: false,
          state: estimate.state === 'subscription' ? 'subscription' : 'unknown',
        },
      };
    },
  };
}
export function nativeTurnMetrics(
  receipts: readonly NativeReceipt[],
): NativeReceipt & { estimatedCostUsd?: number } {
  if (receipts.length === 0) return {};
  let acc = createUsageAccumulator();
  const components: CostEstimate[] = [];
  for (const receipt of receipts) {
    if (receipt.usage) {
      acc = accumulateUsage(acc, { type: 'usage_delta', usage: receipt.usage });
      acc = accumulateUsage(acc, { type: 'message_stop', stop_reason: 'end_turn' });
    }
    if (receipt.costEstimate)
      components.push({
        ...receipt.costEstimate,
        ...(receipt.usage ? { usage: receipt.usage } : {}),
      });
  }
  const usage = finalizeUsage(acc);
  const first = components[0];
  if (!first) return usage ? { usage } : {};
  const complete =
    components.length === receipts.length &&
    components.every((part) => part.complete && part.amountUsd !== undefined);
  const amountUsd = complete
    ? components.reduce((sum, part) => sum + (part.amountUsd ?? 0), 0)
    : undefined;
  const state = components.every((part) => part.state === 'subscription')
    ? 'subscription'
    : !complete
      ? 'unknown'
      : amountUsd === 0
        ? 'free'
        : 'paid';
  return {
    ...(usage ? { usage } : {}),
    costEstimate: {
      scope: 'aggregate',
      provider: first.provider,
      model: first.model,
      source: 'native-turn-components',
      version: 1,
      pricedAt: first.pricedAt,
      state,
      complete,
      components,
      ...(amountUsd !== undefined ? { amountUsd } : {}),
    },
    ...(amountUsd !== undefined ? { estimatedCostUsd: amountUsd } : {}),
  };
}

/** Bound active telemetry; detailed per-request receipts remain in the session store. */
export function appendNativeReceipt(receipts: NativeReceipt[], receipt: NativeReceipt): void {
  receipts.push(receipt);
  if (receipts.length <= 64) return;
  const aggregate = nativeTurnMetrics(receipts.splice(0, 32));
  const { components: _parts, ...cost } = aggregate.costEstimate ?? {};
  receipts.unshift({
    ...(aggregate.usage ? { usage: aggregate.usage } : {}),
    ...(aggregate.costEstimate ? { costEstimate: cost as CostEstimate } : {}),
  });
}
