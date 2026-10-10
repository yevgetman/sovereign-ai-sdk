import { describe, expect, test } from 'bun:test';
import { TreeBudget, TreeBudgetExceededError, budgetProvider } from '@yevgetman/sov-sdk';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { fallbackModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
const request: ProviderRequest = { model: 'gpt-4o-mini', system: [], messages: [], maxTokens: 10 };
async function drain(provider: LLMProvider): Promise<void> {
  for await (const _event of provider.stream(request)) {
    /* drain */
  }
}
function provider(withUsage = true): LLMProvider {
  return {
    name: 'openai',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      yield { type: 'message_start' };
      if (withUsage) {
        yield { type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 1 } };
        yield { type: 'usage_delta', usage: { outputTokens: 3, reasoningTokens: 2 } };
      }
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: answer };
      return answer;
    },
  };
}

describe('shared tree budgets', () => {
  test('depth, concurrent and cumulative child reservations are atomic and release once', () => {
    const budget = new TreeBudget({ maxDepth: 2, maxConcurrentChildren: 1, maxTotalChildren: 2 });
    expect(() => budget.reserveChild(3)).toThrow(TreeBudgetExceededError);
    const release = budget.reserveChild(1);
    expect(() => budget.reserveChild(1)).toThrow(TreeBudgetExceededError);
    release();
    release();
    budget.reserveChild(2)();
    expect(() => budget.reserveChild(1)).toThrow(TreeBudgetExceededError);
    expect(budget.snapshot()).toMatchObject({ activeChildren: 0, totalChildren: 2 });
  });

  test('request bounds reserve concurrently, settle cumulative usage, and do not double count reasoning', async () => {
    const budget = new TreeBudget({ maxTotalTokens: 20, maxEstimatedCostUsd: 1 });
    const release = budget.reserveRequest({ tokens: 11, estimatedCostUsd: 0.1 });
    expect(() => budget.reserveRequest({ tokens: 10, estimatedCostUsd: 0.1 })).toThrow(
      TreeBudgetExceededError,
    );
    release({ inputTokens: 3, outputTokens: 2 }, 0.01);
    release({ inputTokens: 100, outputTokens: 100 }, 1);
    await drain(budgetProvider(provider(), budget, () => ({ tokens: 10, estimatedCostUsd: 0.01 })));
    expect(budget.snapshot()).toMatchObject({
      accountedTokens: 13,
      unknownRequests: 0,
      exhausted: false,
    });
    expect(budget.snapshot().accountedEstimatedCostUsd).toBeCloseTo(0.01000255, 8);
  });

  test('mutable shared estimates cannot change concurrent reservations or free admission', () => {
    const budget = new TreeBudget({ maxTotalTokens: 100, maxEstimatedCostUsd: 1 });
    const estimate = { tokens: 50, estimatedCostUsd: 0.5 };
    const first = budget.reserveRequest(estimate);
    const second = budget.reserveRequest(estimate);
    estimate.tokens = 1000;
    estimate.estimatedCostUsd = 10;
    first({ inputTokens: 20, outputTokens: 20 }, 0.4);
    expect(budget.snapshot().accountedTokens).toBe(90);
    expect(budget.snapshot().accountedEstimatedCostUsd).toBeCloseTo(0.9);
    expect(() => budget.reserveRequest({ tokens: 11, estimatedCostUsd: 0.01 })).toThrow(
      TreeBudgetExceededError,
    );
    expect(() => budget.reserveRequest({ tokens: 0, estimatedCostUsd: 0.11 })).toThrow(
      TreeBudgetExceededError,
    );
    estimate.tokens = 0;
    estimate.estimatedCostUsd = 0;
    second({ inputTokens: 10, outputTokens: 10 }, 0.2);
    expect(budget.snapshot().accountedTokens).toBe(60);
    expect(budget.snapshot().accountedEstimatedCostUsd).toBeCloseTo(0.6);
    expect(budget.snapshot().exhausted).toBe(false);
  });

  test('missing and partial usage retain upper bounds and are marked unknown', async () => {
    const budget = new TreeBudget({ maxTotalTokens: 10, maxEstimatedCostUsd: 0.1 });
    await drain(
      budgetProvider(provider(false), budget, () => ({ tokens: 10, estimatedCostUsd: 0.1 })),
    );
    expect(budget.snapshot()).toMatchObject({
      accountedTokens: 10,
      accountedEstimatedCostUsd: 0.1,
      unknownRequests: 1,
    });
    await expect(
      drain(budgetProvider(provider(), budget, () => ({ tokens: 10, estimatedCostUsd: 0.1 }))),
    ).rejects.toThrow(TreeBudgetExceededError);
    const partial = new TreeBudget({ maxTotalTokens: 10 });
    partial.reserveRequest({ tokens: 10 })({ outputTokens: 1 });
    expect(partial.snapshot()).toMatchObject({ accountedTokens: 10, unknownRequests: 1 });
  });

  test('unknown prices cannot silently free a cost reservation', async () => {
    const budget = new TreeBudget({ maxEstimatedCostUsd: 0.1 });
    const unknown = { ...provider(), name: 'unpriced-host' };
    await drain(budgetProvider(unknown, budget, () => ({ tokens: 10, estimatedCostUsd: 0.1 })));
    expect(budget.snapshot()).toMatchObject({ accountedEstimatedCostUsd: 0.1, unknownRequests: 1 });
  });

  test('a token-only budget still labels an unpriced cost as unknown', async () => {
    const budget = new TreeBudget({ maxTotalTokens: 10 });
    await drain(
      budgetProvider({ ...provider(), name: 'unpriced-host' }, budget, () => ({ tokens: 10 })),
    );
    expect(budget.snapshot()).toMatchObject({
      accountedTokens: 8,
      tokenUsageComplete: true,
      estimatedCostComplete: false,
      unknownRequests: 1,
    });
  });

  test('reported overruns stop further requests; costs require explicit bounds', () => {
    const budget = new TreeBudget({ maxTotalTokens: 10 });
    budget.reserveRequest({ tokens: 10 })({ inputTokens: 8, outputTokens: 8 });
    expect(budget.snapshot()).toMatchObject({ accountedTokens: 16, exhausted: true });
    expect(() => budget.reserveRequest({ tokens: 0 })).toThrow(TreeBudgetExceededError);
    expect(() => new TreeBudget({ maxEstimatedCostUsd: 1 }).reserveRequest({ tokens: 10 })).toThrow(
      'cost upper bound',
    );
  });

  test('observed partial usage beyond a reservation exhausts admission', () => {
    const budget = new TreeBudget({ maxTotalTokens: 10 });
    budget.reserveRequest({ tokens: 10 })({ outputTokens: 11 });
    expect(budget.snapshot()).toMatchObject({
      accountedTokens: 11,
      unknownRequests: 1,
      tokenUsageComplete: false,
      exhausted: true,
    });
    expect(() => budget.reserveRequest({ tokens: 0 })).toThrow(TreeBudgetExceededError);
  });

  test.each(['before stop', 'after stop', 'sync cleanup', 'async cleanup'] as const)(
    '%s failure retains observed overruns without refunding reservations',
    async (phase) => {
      const underlying: LLMProvider = {
        name: 'openai',
        stream() {
          const stream = (async function* (): AsyncGenerator<StreamEvent, AssistantMessage> {
            yield { type: 'usage_delta', usage: { inputTokens: 1, outputTokens: 11 } };
            if (phase === 'before stop') throw new Error('fixture disconnect');
            yield { type: 'message_stop', stop_reason: 'end_turn' };
            if (phase === 'after stop') throw new Error('fixture disconnect');
            return answer;
          })();
          if (phase === 'sync cleanup' || phase === 'async cleanup') {
            const fail = () => {
              throw new Error('fixture cleanup failed');
            };
            stream.return = phase === 'sync cleanup' ? fail : async () => fail();
          }
          return stream;
        },
      };
      const budget = new TreeBudget({ maxTotalTokens: 10, maxEstimatedCostUsd: 0.1 });
      await expect(
        drain(budgetProvider(underlying, budget, () => ({ tokens: 10, estimatedCostUsd: 0.1 }))),
      ).rejects.toThrow();
      expect(budget.snapshot()).toMatchObject({
        accountedTokens: 12,
        accountedEstimatedCostUsd: 0.1,
        exhausted: true,
        tokenUsageComplete: false,
        estimatedCostComplete: false,
        unknownRequests: 1,
      });
      expect(() => budget.reserveRequest({ tokens: 0, estimatedCostUsd: 0 })).toThrow(
        TreeBudgetExceededError,
      );
    },
  );

  test.each(['before final', 'after final', 'cancel final'] as const)(
    '%s consumer close distinguishes complete billing from unknown usage',
    async (phase) => {
      const budget = new TreeBudget({ maxTotalTokens: 10, maxEstimatedCostUsd: 0.1 });
      const controller = new AbortController();
      const stream = budgetProvider(provider(), budget, () => ({
        tokens: 10,
        estimatedCostUsd: 0.1,
      })).stream({ ...request, signal: controller.signal });
      for (;;) {
        const step = await stream.next();
        expect(step.done).toBe(false);
        if (
          !step.done &&
          step.value.type === (phase === 'before final' ? 'message_stop' : 'assistant_message')
        )
          break;
      }
      if (phase === 'cancel final') controller.abort();
      await stream.return(answer);
      const complete = phase === 'after final';
      expect(budget.snapshot()).toMatchObject({
        accountedTokens: complete ? 8 : 10,
        tokenUsageComplete: complete,
        estimatedCostComplete: complete,
        unknownRequests: complete ? 0 : 1,
        exhausted: false,
      });
      if (!complete) expect(budget.snapshot().accountedEstimatedCostUsd).toBe(0.1);
    },
  );

  test('consumer return joins provider cleanup and conservatively accounts missing usage', async () => {
    let closed = false;
    const underlying: LLMProvider = {
      name: 'openai',
      async *stream() {
        try {
          yield { type: 'message_start' } as const;
          return answer;
        } finally {
          closed = true;
        }
      },
    };
    const budget = new TreeBudget({ maxTotalTokens: 10 });
    const stream = budgetProvider(underlying, budget, () => ({ tokens: 10 })).stream(request);
    await stream.next();
    await stream.return(answer);
    expect(closed).toBe(true);
    expect(budget.snapshot()).toMatchObject({ accountedTokens: 10, unknownRequests: 1 });
  });

  test('cancelled partial usage cannot refund a provider request ceiling', async () => {
    const partial: LLMProvider = {
      name: 'openai',
      async *stream() {
        yield { type: 'message_start' } as const;
        yield { type: 'usage_delta', usage: { inputTokens: 1, outputTokens: 1 } } as const;
        return answer;
      },
    };
    const budget = new TreeBudget({ maxTotalTokens: 10, maxEstimatedCostUsd: 0.1 });
    await drain(budgetProvider(partial, budget, () => ({ tokens: 10, estimatedCostUsd: 0.1 })));
    expect(budget.snapshot()).toMatchObject({
      accountedTokens: 10,
      accountedEstimatedCostUsd: 0.1,
      tokenUsageComplete: false,
      estimatedCostComplete: false,
      unknownRequests: 1,
    });
  });

  test('malformed provider accounting cannot free a reservation', () => {
    const budget = new TreeBudget({ maxTotalTokens: 10 });
    budget.reserveRequest({ tokens: 10 })({ inputTokens: -1, outputTokens: 0 });
    expect(budget.snapshot()).toMatchObject({
      accountedTokens: 10,
      unknownRequests: 1,
      exhausted: true,
    });
  });

  test('invalid limits and insufficient request bounds fail before any provider call', async () => {
    expect(() => new TreeBudget({ maxDepth: -1 })).toThrow('invalid');
    expect(() => new TreeBudget({ maxTotalChildren: 0.5 })).toThrow('invalid');
    const budget = new TreeBudget({ maxTotalTokens: 10 });
    await expect(drain(budgetProvider(provider(), budget, () => ({ tokens: 5 })))).rejects.toThrow(
      'smaller than maxTokens',
    );
    expect(budget.snapshot().accountedTokens).toBe(0);
  });
});

test('model-bound unknown pricing keeps the host cost reservation for a known built-in ID', async () => {
  const budget = new TreeBudget({ maxEstimatedCostUsd: 1 });
  const metadata = findModel(fallbackModelCatalog('openai-api'), 'gpt-4o-mini');
  const wrapped = budgetProvider(provider(), budget, () => ({ tokens: 10, estimatedCostUsd: 0.5 }));
  for await (const _event of wrapped.stream({ ...request, modelMetadata: metadata })) {
    /* drain */
  }
  expect(budget.snapshot()).toMatchObject({
    accountedTokens: 8,
    accountedEstimatedCostUsd: 0.5,
    unknownRequests: 1,
    tokenUsageComplete: true,
    estimatedCostComplete: false,
  });
  expect(() => budget.reserveRequest({ tokens: 10, estimatedCostUsd: 0.6 })).toThrow(
    TreeBudgetExceededError,
  );
});

test('metadata-absent callers retain established built-in tree pricing', async () => {
  const budget = new TreeBudget({ maxEstimatedCostUsd: 1 });
  await drain(budgetProvider(provider(), budget, () => ({ tokens: 10, estimatedCostUsd: 0.5 })));
  expect(budget.snapshot().accountedEstimatedCostUsd).toBeCloseTo(0.00000255, 10);
  expect(budget.snapshot()).toMatchObject({ unknownRequests: 0, estimatedCostComplete: true });
});

test('tree prices and identities are frozen before host callbacks and stream events', async () => {
  const metadata = {
    ...findModel(fallbackModelCatalog('openai-api'), 'future'),
    pricing: {
      state: 'paid' as const,
      currency: 'USD' as const,
      source: 'fixture',
      inputPerMillion: 1_000_000,
      outputPerMillion: 1_000_000,
    },
  };
  const mutableRequest = { ...request, model: 'future', modelMetadata: metadata };
  const underlying = provider();
  const budget = new TreeBudget({ maxEstimatedCostUsd: 10 });
  const wrapped = budgetProvider(underlying, budget, () => {
    metadata.pricing.inputPerMillion = 0;
    return { tokens: 10, estimatedCostUsd: 10 };
  });
  const stream = wrapped.stream(mutableRequest);
  await stream.next();
  metadata.pricing.outputPerMillion = 0;
  mutableRequest.model = 'different';
  metadata.id = 'different';
  Object.defineProperty(underlying, 'name', { value: 'other' });
  while (!(await stream.next()).done) {
    /* drain */
  }
  expect(budget.snapshot()).toMatchObject({
    accountedEstimatedCostUsd: 8,
    estimatedCostComplete: true,
    unknownRequests: 0,
  });
});
