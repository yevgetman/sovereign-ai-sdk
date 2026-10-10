import type { AssistantMessage, TokenUsage } from '../core/types.js';
import {
  accumulateUsage,
  createUsageAccumulator,
  finalizeUsage,
} from '../core/usageAccumulator.js';
import {
  type PricingSnapshot,
  estimateUsageCost,
  pricingSnapshotForModel,
} from '../providers/pricing.js';
import type { LLMProvider, ProviderRequest } from '../providers/types.js';

export type TreeBudgetLimits = {
  maxDepth?: number;
  maxTotalChildren?: number;
  maxConcurrentChildren?: number;
  maxTotalTokens?: number;
  maxEstimatedCostUsd?: number;
};

/** A host's upper bound, including request input/cache/output and any billable reasoning. */
export type RequestBudgetEstimate = { tokens: number; estimatedCostUsd?: number };
export type EstimateRequestBudget = (request: ProviderRequest) => RequestBudgetEstimate;
export type TreeBudgetSnapshot = {
  totalChildren: number;
  activeChildren: number;
  accountedTokens: number;
  accountedEstimatedCostUsd: number;
  unknownRequests: number;
  tokenUsageComplete: boolean;
  estimatedCostComplete: boolean;
  exhausted: boolean;
};

export class TreeBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeBudgetExceededError';
  }
}

/** One shared host-owned object per tree. Reservations are synchronous and atomic. */
export class TreeBudget {
  private state: TreeBudgetSnapshot = {
    totalChildren: 0,
    activeChildren: 0,
    accountedTokens: 0,
    accountedEstimatedCostUsd: 0,
    unknownRequests: 0,
    tokenUsageComplete: true,
    estimatedCostComplete: true,
    exhausted: false,
  };
  readonly limits: Readonly<TreeBudgetLimits>;

  constructor(limits: TreeBudgetLimits) {
    for (const [key, value] of Object.entries(limits)) {
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (key !== 'maxEstimatedCostUsd' && !Number.isSafeInteger(value))
      ) {
        throw new Error(`invalid tree budget ${key}`);
      }
    }
    this.limits = Object.freeze({ ...limits });
  }

  snapshot(): TreeBudgetSnapshot {
    return { ...this.state };
  }

  reserveChild(depth: number): () => void {
    if (!Number.isInteger(depth) || depth < 1) throw new Error('child depth must be positive');
    this.check('depth', depth, this.limits.maxDepth);
    this.check('total children', this.state.totalChildren + 1, this.limits.maxTotalChildren);
    this.check('active children', this.state.activeChildren + 1, this.limits.maxConcurrentChildren);
    this.state.totalChildren++;
    this.state.activeChildren++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.state.activeChildren--;
    };
  }

  /** Reserve BEFORE calling a provider. Incomplete results retain the whole bound
   * or a larger observed lower bound. usageComplete defaults true for host settlement. */
  reserveRequest(
    estimate: RequestBudgetEstimate,
  ): (usage?: TokenUsage, cost?: number, usageComplete?: boolean) => void {
    // Capture caller-owned estimates once; settlement must not read a reused object.
    const tokensReserved = estimate.tokens;
    const costReserved = estimate.estimatedCostUsd;
    if (
      !Number.isSafeInteger(tokensReserved) ||
      tokensReserved < 0 ||
      (costReserved !== undefined && (!Number.isFinite(costReserved) || costReserved < 0))
    ) {
      throw new Error('invalid request budget estimate');
    }
    if (this.limits.maxEstimatedCostUsd !== undefined && costReserved === undefined) {
      throw new TreeBudgetExceededError('cost ceiling requires a request cost upper bound');
    }
    this.check('tokens', this.state.accountedTokens + tokensReserved, this.limits.maxTotalTokens);
    this.check(
      'estimated cost',
      this.state.accountedEstimatedCostUsd + (costReserved ?? 0),
      this.limits.maxEstimatedCostUsd,
    );
    this.state.accountedTokens += tokensReserved;
    this.state.accountedEstimatedCostUsd += costReserved ?? 0;
    let settled = false;
    return (usage, cost, usageComplete = true) => {
      if (settled) return;
      settled = true;
      if (
        usage !== undefined &&
        Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)
      ) {
        this.state.unknownRequests++;
        this.state.tokenUsageComplete = false;
        this.state.estimatedCostComplete = false;
        this.state.exhausted = true;
        return;
      }
      const knownTokens =
        usageComplete &&
        usage !== undefined &&
        usage.inputTokens !== undefined &&
        usage.outputTokens !== undefined;
      const observedTokens =
        (usage?.inputTokens ?? 0) +
        (usage?.outputTokens ?? 0) +
        (usage?.cacheCreationInputTokens ?? 0) +
        (usage?.cacheReadInputTokens ?? 0);
      // Missing counters cannot erase a proven overrun in the counters reported.
      const tokens = knownTokens ? observedTokens : Math.max(tokensReserved, observedTokens);
      const knownCost = cost !== undefined && Number.isFinite(cost) && cost >= 0;
      if (!knownTokens || !knownCost) this.state.unknownRequests++;
      if (!knownTokens) this.state.tokenUsageComplete = false;
      if (!knownCost) this.state.estimatedCostComplete = false;
      this.state.accountedTokens += tokens - tokensReserved;
      this.state.accountedEstimatedCostUsd +=
        (knownCost ? cost : (costReserved ?? 0)) - (costReserved ?? 0);
      if (
        tokens > tokensReserved ||
        (knownCost && costReserved !== undefined && cost > costReserved)
      ) {
        this.state.exhausted = true;
      }
    };
  }

  private check(label: string, next: number, maximum: number | undefined): void {
    if (this.state.exhausted || (maximum !== undefined && next > maximum)) {
      throw new TreeBudgetExceededError(`tree budget exceeded: ${label}`);
    }
  }
}

/** Wrap parent, child and compaction providers with the same budget to account the tree. */
export function budgetProvider(
  provider: LLMProvider,
  budget: TreeBudget,
  estimate: EstimateRequestBudget,
): LLMProvider {
  return {
    name: provider.name,
    async *stream(
      request,
    ): AsyncGenerator<import('../core/types.js').StreamEvent, AssistantMessage> {
      // Capture identity and tariffs before host callbacks or provider awaits.
      const providerName = provider.name;
      const model = request.model;
      const metadata = request.modelMetadata;
      const initialPrice = estimateUsageCost(
        providerName,
        model,
        { inputTokens: 0, outputTokens: 0 },
        metadata ? pricingSnapshotForModel(metadata) : undefined,
      );
      const pricingSnapshot: PricingSnapshot = {
        provider: providerName,
        model,
        state: initialPrice.state,
        source: initialPrice.source,
        version: initialPrice.version,
        fetchedAt: initialPrice.pricedAt,
        ...(initialPrice.rates
          ? {
              rates: {
                ...initialPrice.rates,
                // Preserve the legacy table's implicit base-rate cache fallback.
                ...(!metadata
                  ? {
                      cacheCreationInput:
                        initialPrice.rates.cacheCreationInput ?? initialPrice.rates.input,
                      cacheReadInput: initialPrice.rates.cacheReadInput ?? initialPrice.rates.input,
                    }
                  : {}),
              },
            }
          : {}),
      };
      const bound = estimate(request);
      if (bound.tokens < request.maxTokens) {
        throw new TreeBudgetExceededError('request token upper bound is smaller than maxTokens');
      }
      const settle = budget.reserveRequest(bound);
      let usage = createUsageAccumulator();
      let stopped = false;
      let finished = false;
      let finalMessage = false;
      let failed = false;
      let stream: ReturnType<LLMProvider['stream']> | undefined;
      try {
        stream = provider.stream(request);
        for (;;) {
          const step = await stream.next();
          if (step.done) {
            finished = true;
            return step.value;
          }
          if (step.value.type === 'message_stop') stopped = true;
          if (step.value.type === 'assistant_message') finalMessage = true;
          usage = accumulateUsage(usage, step.value);
          yield step.value;
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        let cleanupSucceeded = false;
        try {
          await stream?.return({ role: 'assistant', content: [] });
          cleanupSucceeded = true;
        } finally {
          const total = finalizeUsage(usage);
          const usageComplete =
            stopped &&
            (finished || finalMessage) &&
            !failed &&
            cleanupSucceeded &&
            !request.signal?.aborted;
          const estimate = total
            ? estimateUsageCost(providerName, model, total, pricingSnapshot)
            : undefined;
          const priced =
            total !== undefined &&
            total.inputTokens !== undefined &&
            total.outputTokens !== undefined &&
            estimate?.complete === true;
          settle(total, usageComplete && priced ? estimate?.amountUsd : undefined, usageComplete);
        }
      }
    },
  };
}
