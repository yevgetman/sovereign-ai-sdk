import { expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import { modelInputTokenAccounting } from '@yevgetman/sov-sdk/providers/tokenAccounting';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { shouldCompactModelRequest } from '../../src/server/modelMetadata.js';

test('a normal fitting OpenAI prompt is admitted instead of counting its UTF-8 bytes as tokens', async () => {
  const calls: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(request) {
      calls.push(request);
      const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'ok' }],
      };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' as const };
      return message;
    },
  };
  const loop = query({
    provider,
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'The owner wants a clear answer. '.repeat(2500) }],
      },
    ],
    systemPrompt: [],
    maxTokens: 100,
    modelMetadata: {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      provider: 'openai',
      routeId: 'openai-api',
      auth: 'api_key',
      capabilities: {
        textOutput: 'supported',
        images: 'supported',
        tools: 'supported',
        reasoning: 'unsupported',
      },
      contextWindow: 32768,
      maxOutputTokens: 100,
      availability: 'advertised',
      metadata: { stale: false, source: 'fixture' },
    },
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) {
      expect(step.value.reason).toBe('completed');
      break;
    }
  }
  expect(calls).toHaveLength(1);
});

test('unknown native tokenizer is advisory and cannot buy compaction from its byte upper bound', () => {
  const messages = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Continue clearly. '.repeat(8000) }],
    },
  ];
  for (const [provider, model] of [
    ['grok', 'grok-4.7'],
    ['anthropic', 'claude-opus-4-7'],
    ['openrouter', 'unknown/future'],
    ['openai', 'unpublished'],
  ]) {
    const counter = modelInputTokenAccounting(provider as string);
    const accounting = counter({ model: model as string, messages, system: [], maxTokens: 100 });
    expect(accounting.conservativeTokens).toBeGreaterThan(32000);
    expect(accounting.measuredTokens).toBeUndefined();
    expect(accounting.complete).toBe(false);
    expect(accounting.enforce).toBe(false);
    expect(accounting.uncountedModalities).toContain('tokenizer');
    expect(
      shouldCompactModelRequest(
        messages,
        [],
        [],
        { contextTokens: 32000, outputTokens: 100, source: 'fixture' },
        0.75,
        { counter, model: model as string },
      ),
    ).toBe(false);
  }
});

test('wire accounting includes Unicode, long paths, schemas and tool results without treating special-looking text as control', () => {
  const counter = modelInputTokenAccounting('openai');
  const base: ProviderRequest = {
    model: 'gpt-4o',
    system: [{ text: 'Follow the owner.', cacheable: false }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '你好 😀 café /very/long/path/to/a/file <|endoftext|>' }],
      },
    ],
    maxTokens: 100,
  };
  const baseline = counter(base);
  const expanded = counter({
    ...base,
    tools: [
      {
        name: 'read_file',
        description: 'Read the file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    messages: [
      ...base.messages,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/file' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'File result contains information.'.repeat(50),
          },
        ],
      },
    ],
  });
  expect(expanded.tokens).toBeGreaterThan(baseline.tokens);
  expect(expanded.measuredTokens).toBeGreaterThan(baseline.measuredTokens as number);
  expect(expanded.conservativeTokens).toBe(expanded.tokens);
  expect(expanded.source).toContain('o200k_base:chunked-wire-estimate');
  expect(expanded.version).toBe('1.0.21/framing-1');
});

test('encoded images and encrypted reasoning stay uncounted, never falsely measured as text', () => {
  const counter = modelInputTokenAccounting('chatgpt');
  const accounting = counter({
    model: 'gpt-5',
    system: [],
    maxTokens: 100,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100000) },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'encrypted_reasoning',
            encryptedContent: 'A'.repeat(100000),
            routeId: 'chatgpt-subscription',
          },
        ],
      },
    ],
  });
  expect(accounting.tokens).toBeLessThan(1000);
  expect(accounting.complete).toBe(false);
  expect(accounting.enforce).toBe(false);
  expect(accounting.uncountedImages).toBe(1);
  expect(accounting.uncountedModalities).toEqual(['image', 'encrypted_reasoning']);
});

test('chunk boundaries around 1024 preserve explicit estimates with Unicode and long paths', () => {
  const counter = modelInputTokenAccounting('openai');
  for (const suffix of ['😀/very/long/path/', '你好/schema/', 'café/tool-result/']) {
    const counts = [1023, 1024, 1025].map((size) =>
      counter({
        model: 'gpt-4o',
        system: [],
        maxTokens: 10,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(size) + suffix }] }],
        tools: [
          {
            name: 'probe',
            description: 'p'.repeat(size),
            input_schema: { type: 'string', description: suffix },
          },
        ],
      }),
    );
    for (const accounting of counts) {
      expect(Number.isSafeInteger(accounting.measuredTokens)).toBe(true);
      expect(accounting.conservativeTokens).toBeGreaterThan(accounting.measuredTokens as number);
      expect(accounting.source).toContain('chunked-wire-estimate');
    }
    expect(
      Math.max(...counts.map((item) => item.tokens)) -
        Math.min(...counts.map((item) => item.tokens)),
    ).toBeLessThan(32);
  }
});

test('an unknown subscription tokenizer admits uncertain fitting text and reports its policy', async () => {
  let calls = 0;
  const traces: import('@yevgetman/sov-sdk/trace/types').TraceEvent[] = [];
  const loop = query({
    provider: {
      name: 'grok',
      async *stream() {
        calls++;
        const message = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'ok' }],
        };
        yield { type: 'assistant_message', message };
        yield { type: 'message_stop', stop_reason: 'end_turn' as const };
        return message;
      },
    },
    model: 'grok-4.7',
    maxTokens: 100,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'The owner wants a clear answer. '.repeat(2500) }],
      },
    ],
    systemPrompt: [],
    traceRecorder: (event) => traces.push(event),
    modelMetadata: {
      id: 'grok-4.7',
      displayName: 'Grok',
      provider: 'grok',
      routeId: 'grok-subscription',
      auth: 'subscription',
      capabilities: {
        textOutput: 'supported',
        images: 'unknown',
        tools: 'supported',
        reasoning: 'unknown',
      },
      contextWindow: 32768,
      maxOutputTokens: 100,
      availability: 'account',
      metadata: { source: 'fixture', stale: false },
    },
  });
  for (;;) {
    const step = await loop.next();
    if (step.done) {
      expect(step.value.reason).toBe('completed');
      break;
    }
  }
  expect(calls).toBe(1);
  const request = traces.find((event) => event.type === 'provider_request');
  expect(request?.type === 'provider_request' ? request.inputAccounting : undefined).toMatchObject({
    complete: false,
    enforce: false,
    effectiveLimit: 32768,
    reservedOutput: 100,
    source: 'grok/grok-4.7:utf8-upper-bound',
    uncountedModalities: ['tokenizer'],
  });
});
