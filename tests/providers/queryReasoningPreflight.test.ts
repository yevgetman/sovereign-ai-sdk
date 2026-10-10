import { expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import { OpenAIProvider } from '@yevgetman/sov-sdk/providers/openai';

test('SDK rejects unsupported reasoning before a paid context reduction', async () => {
  let reductions = 0;
  let fetches = 0;
  const provider = new OpenAIProvider({
    name: 'openrouter',
    apiKey: 'fixture',
    fetchImpl: (async () => {
      fetches++;
      throw new Error('unexpected inference');
    }) as unknown as typeof fetch,
  });
  const modelMetadata: ModelRecord = {
    id: 'fixture/text-only',
    provider: 'openrouter',
    routeId: 'openrouter-api',
    auth: 'api_key',
    displayName: 'fixture',
    availability: 'advertised',
    capabilities: {
      textOutput: 'supported',
      tools: 'supported',
      images: 'unsupported',
      reasoning: 'unsupported',
    },
    metadata: { source: 'fixture', stale: false },
  };
  const agent = createAgent({
    provider,
    model: modelMetadata.id,
    modelMetadata,
    effort: 'high',
    maxTokens: 100,
    contextLimits: { maxHistoryBytes: 200 },
    contextManager: {
      async reduce() {
        reductions++;
        return {
          messages: [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }],
          estimatedCostUsd: 0.01,
        };
      },
    },
  });
  const events = [];
  const gen = agent.run('history '.repeat(500));
  let result: Awaited<ReturnType<typeof gen.next>>['value'] | undefined;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }
  expect(result && 'terminal' in result && result.terminal.reason).toBe('error');
  expect(reductions).toBe(0);
  expect(fetches).toBe(0);
  expect(events.some((event) => 'type' in event && event.type === 'context_management')).toBe(
    false,
  );
});
