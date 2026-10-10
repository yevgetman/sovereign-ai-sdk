import { expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import { AnthropicProvider } from '@yevgetman/sov-sdk/providers/anthropic';
import { requestInputTokenBound } from '@yevgetman/sov-sdk/providers/modelLimits';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
const metadata = (window: number, output: number): ModelRecord => ({
  id: 'future',
  provider: 'fake',
  routeId: 'fake-api',
  auth: 'custom',
  displayName: 'Future',
  capabilities: {
    textOutput: 'supported',
    tools: 'unknown',
    images: 'unknown',
    reasoning: 'unknown',
  },
  availability: 'unknown',
  contextWindow: window,
  maxOutputTokens: output,
  metadata: { stale: false, source: 'fixture' },
});
function mockProvider(calls: ProviderRequest[]): LLMProvider {
  return {
    name: 'fake',
    async *stream(req) {
      calls.push(req);
      const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'ok' }],
      };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' as const };
      return message;
    },
  };
}
async function run(record: ModelRecord, text: string, calls: ProviderRequest[], cap?: number) {
  const loop = query({
    provider: mockProvider(calls),
    model: record.id,
    modelMetadata: record,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    systemPrompt: [],
    maxTokens: 12000,
    ...(cap
      ? {
          contextLimits: { maxHistoryBytes: 100000, contextWindowTokens: cap },
          contextManager: {
            async reduce(req) {
              return { messages: [...req.messages] };
            },
          },
        }
      : {}),
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) return step.value;
  }
}
test('output max is reserved and clamped before the provider receives a request', async () => {
  const calls: ProviderRequest[] = [];
  expect((await run(metadata(10000, 100), 'hello', calls)).reason).toBe('completed');
  expect(calls[0]?.maxTokens).toBe(100);
});
test('resume with a smaller model rejects intact history before inference', async () => {
  const calls: ProviderRequest[] = [];
  const history = 'x'.repeat(2000);
  expect((await run(metadata(10000, 100), history, calls)).reason).toBe('completed');
  expect((await run(metadata(2000, 100), history, calls)).reason).toBe('error');
  expect(calls).toHaveLength(1);
});
test('host cap and failed authorized reduction cannot silently discard history', async () => {
  const calls: ProviderRequest[] = [];
  expect((await run(metadata(500000, 100), 'x'.repeat(2000), calls, 2000)).reason).toBe('error');
  expect(calls).toHaveLength(0);
});

test('host verified accounting receives exact model/system/tools and avoids byte-bound false rejection', async () => {
  const calls: ProviderRequest[] = [];
  const record = metadata(1000, 100);
  let counted = 0;
  const loop = query({
    provider: mockProvider(calls),
    model: record.id,
    modelMetadata: record,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }],
    systemPrompt: [{ text: 'system', cacheable: false }],
    maxTokens: 100,
    inputTokenCounter(request) {
      counted++;
      expect(request.model).toBe(record.id);
      expect(request.system[0]?.text).toBe('system');
      return 100;
    },
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) {
      expect(step.value.reason).toBe('completed');
      break;
    }
  }
  expect(counted).toBe(1);
  expect(calls).toHaveLength(1);
});

test('explicit host context cap marks output budget without model metadata', async () => {
  const calls: ProviderRequest[] = [];
  const loop = query({
    provider: mockProvider(calls),
    model: 'future',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    systemPrompt: [],
    maxTokens: 1500,
    contextLimits: { maxHistoryBytes: 100000, contextWindowTokens: 2000 },
    contextManager: {
      async reduce(request) {
        return { messages: [...request.messages] };
      },
    },
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) {
      expect(step.value.reason).toBe('completed');
      break;
    }
  }
  expect(calls[0]?.outputBudgetEnforced).toBe(true);
  expect(calls[0]?.maxTokens).toBe(1500);
  expect(calls[0]?.modelMetadata).toBeUndefined();
});

test('unknown 32K window adapts output ceiling without truncating standing input or paying for summary', async () => {
  const calls: ProviderRequest[] = [];
  const record = metadata(32768, 8192);
  record.contextWindow = undefined;
  record.maxOutputTokens = undefined;
  record.metadata = { source: 'bundled-suggestions', stale: true };
  const systemPrompt = [{ text: 'x'.repeat(28000), cacheable: false }];
  const messages = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'continue' }] },
  ];
  const expected = 32768 - requestInputTokenBound(messages, systemPrompt, []);
  let reductions = 0;
  const loop = query({
    provider: mockProvider(calls),
    model: record.id,
    modelMetadata: record,
    systemPrompt,
    messages,
    maxTokens: 12000,
    contextLimits: { maxHistoryBytes: 100000, contextWindowTokens: 32768 },
    contextManager: {
      async reduce(req) {
        reductions++;
        return { messages: [...req.messages] };
      },
    },
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) {
      expect(step.value.reason).toBe('completed');
      break;
    }
  }
  expect(calls[0]?.maxTokens).toBe(expected);
  expect(expected).toBeGreaterThan(0);
  expect(expected).toBeLessThan(8192);
  expect(calls[0]?.system).toEqual(systemPrompt);
  expect(calls[0]?.messages[0]).toEqual(messages[0]);
  expect(reductions).toBe(0);
});

test('adaptive output never hides input that fills or exceeds the context window', async () => {
  for (const inputTokens of [1000, 1001]) {
    const calls: ProviderRequest[] = [];
    const record = metadata(1000, 100);
    const loop = query({
      provider: mockProvider(calls),
      model: record.id,
      modelMetadata: record,
      systemPrompt: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'keep intact' }] }],
      maxTokens: 100,
      inputTokenCounter: () => inputTokens,
    });
    for (;;) {
      const step = await loop.next();
      if (step.done) {
        expect(step.value.reason).toBe('error');
        break;
      }
    }
    expect(calls).toHaveLength(0);
  }
});

test('adapted output below Anthropic thinking minimum fails before inference', async () => {
  const calls: ProviderRequest[] = [];
  const base = mockProvider(calls);
  const adapter = new AnthropicProvider({ apiKey: 'fake' });
  const record = {
    ...metadata(2000, 1500),
    provider: 'anthropic',
    routeId: 'anthropic-api',
    id: 'claude-sonnet-4-6',
  };
  const provider: LLMProvider = {
    name: 'anthropic',
    async *stream(req) {
      adapter.buildKwargs(req);
      return yield* base.stream(req);
    },
  };
  const loop = query({
    provider,
    model: record.id,
    modelMetadata: record,
    systemPrompt: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'keep input' }] }],
    maxTokens: 1500,
    effort: 'high',
    inputTokenCounter: () => 1500,
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) {
      expect(step.value.reason).toBe('error');
      break;
    }
  }
  expect(calls).toHaveLength(0);
});
