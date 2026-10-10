import { expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import { AnthropicProvider } from '@yevgetman/sov-sdk/providers/anthropic';
import {
  requestInputTokenBound,
  requestInputTokenEstimate,
} from '@yevgetman/sov-sdk/providers/modelLimits';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
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

test('image payload bytes do not become text tokens and uncertainty is explicit', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  // Valid ancillary tEXt chunk before IEND: payload size is independent of pixels.
  const original = Buffer.from(png, 'base64');
  const text = Buffer.from(`Comment\0${'A'.repeat(200000)}`);
  const chunkTypeAndData = Buffer.concat([Buffer.from('tEXt'), text]);
  let crc = 0xffffffff;
  for (const byte of chunkTypeAndData) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(text.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const bytes = Buffer.concat([
    original.subarray(0, -12),
    length,
    chunkTypeAndData,
    checksum,
    original.subarray(-12),
  ]);
  const image = {
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/png', data: bytes.toString('base64') },
  };
  const messages = [{ role: 'user' as const, content: [image] }];
  const estimate = requestInputTokenEstimate(messages, [], []);
  expect(estimate.complete).toBe(false);
  expect(estimate.uncountedImages).toBe(1);
  expect(estimate.tokens).toBeLessThan(1000);
  // Foreign URL-shaped image blocks are still images, never URL-text token counts.
  const urlMessages = [
    {
      role: 'user' as const,
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }],
    },
  ] as unknown as typeof messages;
  expect(requestInputTokenEstimate(urlMessages, [], []).uncountedImages).toBe(1);
  expect(requestInputTokenEstimate(urlMessages, [], []).tokens).toBe(estimate.tokens);
  for (const inputTokenCounter of [undefined, () => 200000]) {
    const calls: ProviderRequest[] = [];
    const record = metadata(128000, 8192);
    const traces: TraceEvent[] = [];
    const loop = query({
      provider: mockProvider(calls),
      model: record.id,
      modelMetadata: record,
      messages,
      systemPrompt: [],
      maxTokens: 8192,
      traceRecorder: (event) => traces.push(event),
      ...(inputTokenCounter ? { inputTokenCounter } : {}),
    });
    for (;;) {
      const step = await loop.next();
      if (step.done) {
        expect(step.value.reason).toBe(inputTokenCounter ? 'error' : 'completed');
        break;
      }
    }
    expect(calls).toHaveLength(inputTokenCounter ? 0 : 1);
    if (calls[0]) {
      expect(calls[0].messages[0]?.content[0]).toEqual(image);
      const request = traces.find((event) => event.type === 'provider_request');
      expect(request?.type === 'provider_request' ? request.inputAccounting : undefined).toEqual(
        estimate,
      );
    }
  }
  const calls: ProviderRequest[] = [];
  expect((await run(metadata(1000, 100), 'x'.repeat(2000), calls)).reason).toBe('error');
  expect(calls).toHaveLength(0);
});

test('uncounted image costs leave provider context overflow visible', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fake',
    async *stream() {
      calls++;
      yield* [];
      throw new Error('maximum context length exceeded by image tokens');
    },
  };
  const loop = query({
    provider,
    model: 'future',
    modelMetadata: metadata(128000, 8192),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } },
        ],
      },
    ],
    systemPrompt: [],
    maxTokens: 8192,
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) {
      expect(step.value.reason).toBe('error');
      expect(step.value.error?.message).toContain('image tokens');
      break;
    }
  }
  expect(calls).toBe(1);
});
