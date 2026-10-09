import { describe, expect, test } from 'bun:test';
import { TreeBudget, TreeBudgetExceededError, budgetProvider } from '@yevgetman/sov-sdk';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
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
