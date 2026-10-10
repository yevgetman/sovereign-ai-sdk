import { describe, expect, test } from 'bun:test';
import { query } from '@yevgetman/sov-sdk/core/query';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import {
  serializerSupportsImages,
  validateModelRequest,
} from '@yevgetman/sov-sdk/providers/models/validateRequest';
import { OpenAIProvider } from '@yevgetman/sov-sdk/providers/openai';
import { RouteError } from '@yevgetman/sov-sdk/providers/routes/errors';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

const record: ModelRecord = {
  id: 'author/future',
  displayName: 'Future',
  provider: 'openrouter',
  routeId: 'openrouter-api',
  auth: 'api_key',
  capabilities: {
    textOutput: 'supported',
    tools: 'supported',
    images: 'unsupported',
    reasoning: 'unknown',
  },
  availability: 'advertised',
  metadata: { source: 'fixture', stale: false },
};
const image = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: 'aGVsbG8=' },
};
const text: ProviderRequest = {
  model: record.id,
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  maxTokens: 100,
};
describe('model and serializer capabilities', () => {
  test('text-only/no-tool runs work without assuming image support', () => {
    expect(() => validateModelRequest(text, 'openrouter', record)).not.toThrow();
    expect(() =>
      validateModelRequest(text, 'openrouter', {
        ...record,
        capabilities: { ...record.capabilities, tools: 'unknown' },
      }),
    ).not.toThrow();
  });
  test('mixed history is checked before inference, including earlier images', () => {
    const req = {
      ...text,
      messages: [{ role: 'user' as const, content: [image] }, ...text.messages],
    };
    expect(() => validateModelRequest(req, 'openrouter', record)).toThrow('does not support image');
    expect(() =>
      validateModelRequest(req, 'openrouter', {
        ...record,
        capabilities: { ...record.capabilities, images: 'unknown' },
      }),
    ).toThrow('is unknown');
  });
  test('unknown metadata and switched models cannot certify required capabilities', () => {
    expect(() => validateModelRequest({ ...text, model: 'another' }, 'openrouter', record)).toThrow(
      'does not match',
    );
    expect(() => validateModelRequest(text, 'xai', record)).toThrow('does not match');
    expect(() =>
      validateModelRequest(
        { ...text, tools: [{ name: 'run', description: 'run', input_schema: {} }] },
        'openrouter',
        { ...record, capabilities: { ...record.capabilities, tools: 'unknown' } },
      ),
    ).toThrow('is unknown');
  });
  test('tool history and unsupported tool-choice formats are checked', () => {
    expect(() =>
      validateModelRequest(
        {
          ...text,
          messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'run', input: {} }] },
          ],
        },
        'openrouter',
        { ...record, capabilities: { ...record.capabilities, tools: 'unsupported' } },
      ),
    ).toThrow('does not support tools');
    expect(() =>
      validateModelRequest({ ...text, toolChoice: { type: 'any' } }, 'openrouter', {
        ...record,
        toolChoices: ['auto'],
      }),
    ).toThrow('tool-choice');
  });
  test('bundled native suggestions retain established tool and image behavior without certification', () => {
    const bundled = {
      ...record,
      id: 'gpt-4o',
      provider: 'openai',
      routeId: 'openai-api',
      metadata: { source: 'bundled-suggestions', stale: true },
      capabilities: {
        ...record.capabilities,
        images: 'unknown' as const,
        tools: 'unknown' as const,
      },
    };
    const request = {
      ...text,
      model: bundled.id,
      messages: [{ role: 'user' as const, content: [image] }],
      tools: [{ name: 'run', description: 'run', input_schema: {} }],
    };
    expect(() => validateModelRequest(request, 'openai', bundled)).not.toThrow();
    expect(() =>
      validateModelRequest(request, 'openai', {
        ...bundled,
        capabilities: { ...bundled.capabilities, images: 'unsupported' },
      }),
    ).toThrow('does not support image');
    expect(bundled.capabilities.images).toBe('unknown');
  });
  test('fresh direct provider discovery permits unknown tools without claiming support', () => {
    const fresh = {
      ...record,
      id: 'future-native-id',
      provider: 'openai',
      routeId: 'openai-api',
      capabilities: { ...record.capabilities, tools: 'unknown' as const },
      metadata: { source: 'https://api.openai.com/v1/models', stale: false },
    };
    const request = {
      ...text,
      model: fresh.id,
      tools: [{ name: 'run', description: 'run', input_schema: {} }],
    };
    expect(() => validateModelRequest(request, 'openai', fresh)).not.toThrow();
    expect(fresh.capabilities.tools).toBe('unknown');
    expect(() =>
      validateModelRequest(request, 'openai', {
        ...fresh,
        capabilities: { ...fresh.capabilities, tools: 'unsupported' },
      }),
    ).toThrow('does not support tools');
  });
  test('fresh native discovery retains exact established image choices but not unknown new vision', () => {
    const known = {
      ...record,
      id: 'gpt-4o',
      provider: 'openai',
      routeId: 'openai-api',
      capabilities: { ...record.capabilities, images: 'unknown' as const },
      metadata: { source: 'https://api.openai.com/v1/models', stale: false },
    };
    const request = {
      ...text,
      model: known.id,
      messages: [{ role: 'user' as const, content: [image] }],
    };
    expect(() => validateModelRequest(request, 'openai', known)).not.toThrow();
    const future = { ...known, id: 'future-image-model' };
    expect(() => validateModelRequest({ ...request, model: future.id }, 'openai', future)).toThrow(
      'is unknown',
    );
    expect(() =>
      validateModelRequest({ ...request, model: future.id }, 'openai', {
        ...future,
        capabilities: { ...future.capabilities, images: 'supported' },
      }),
    ).not.toThrow();
  });
  test('local and injected image paths retain their serializer contract', () => {
    for (const provider of ['ollama', 'sov', 'manifest']) {
      expect(serializerSupportsImages(provider)).toBe(true);
      expect(() =>
        validateModelRequest({ ...text, messages: [{ role: 'user', content: [image] }] }, provider),
      ).not.toThrow();
    }
    expect(serializerSupportsImages('custom-future')).toBe(false);
    expect(() =>
      validateModelRequest(
        { ...text, messages: [{ role: 'user', content: [image] }] },
        'custom-future',
      ),
    ).not.toThrow();
  });
  test('assistant images are refused rather than silently omitted', () => {
    expect(() =>
      validateModelRequest(
        { ...text, messages: [{ role: 'assistant', content: [image] }] },
        'openrouter',
      ),
    ).toThrow('must use a user');
  });
  test('xAI uses exact OpenAI-compatible image and function-call serialization', () => {
    const provider = new OpenAIProvider({
      name: 'xai',
      apiKey: 'fixture',
      baseURL: 'https://api.x.ai/v1',
    });
    const req = {
      ...text,
      model: 'grok-future',
      messages: [{ role: 'user' as const, content: [image] }],
      tools: [{ name: 'run', description: 'run', input_schema: { type: 'object' } }],
      toolChoice: { type: 'any' as const },
    };
    validateModelRequest(req, 'xai');
    const body = provider.buildKwargs(req);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }],
      },
    ]);
    expect(body.tools?.[0]?.function.name).toBe('run');
    expect(body.tool_choice).toBe('required');
    expect(() => validateModelRequest(req, 'grok')).toThrow('no verified image');
  });
});

test('query rejects unsupported images before either context reduction or inference', async () => {
  let calls = 0;
  let reductions = 0;
  const stream = query({
    provider: {
      name: 'openrouter',
      async *stream() {
        calls += 1;
        const message = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'never' }],
        };
        yield { type: 'assistant_message' as const, message };
        return message;
      },
    },
    model: record.id,
    modelMetadata: record,
    systemPrompt: [],
    messages: [{ role: 'user', content: [image] }],
    maxTokens: 100,
    contextLimits: { maxHistoryBytes: 1 },
    contextManager: {
      async reduce() {
        reductions += 1;
        return { messages: [] };
      },
    },
  });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  expect(next.value.reason).toBe('error');
  if (next.value.reason === 'error') {
    expect(next.value.error).toBeInstanceOf(RouteError);
    expect((next.value.error as RouteError).code).toBe('unsupported_input');
  }
  expect(calls).toBe(0);
  expect(reductions).toBe(0);
});
