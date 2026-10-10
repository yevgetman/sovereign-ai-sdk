import { describe, expect, test } from 'bun:test';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import { OpenAIProvider } from '@yevgetman/sov-sdk/providers/openai';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/catalog';
import { validateRouteSelection } from '@yevgetman/sov-sdk/providers/routes/validate';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
const req = (model: string, effort: ProviderRequest['effort']): ProviderRequest => ({
  model,
  system: [],
  messages: [],
  maxTokens: 2048,
  ...(effort ? { effort } : {}),
});
describe('metadata reasoning and exact transport controls', () => {
  test('direct xAI sends native depth, max maps to xhigh and off is no-control', () => {
    const p = new OpenAIProvider({ name: 'xai', apiKey: 'fake' });
    expect(p.buildKwargs(req('grok-4.6', 'high')).reasoning_effort).toBe('high');
    expect(p.buildKwargs(req('grok-4.6', 'max')).reasoning_effort).toBe('xhigh');
    expect(p.buildKwargs(req('grok-4.6', 'off')).reasoning_effort).toBeUndefined();
    expect(p.buildKwargs(req('grok-4.6', 'high')).max_tokens).toBe(2048);
    expect(validateRouteSelection(getRoute('grok-api'), { effort: 'high' }).effort).toBe('high');
    expect(() => p.buildKwargs(req('grok-future', 'high'))).toThrow();
    expect(() =>
      validateRouteSelection(getRoute('grok-subscription'), { effort: 'high' }),
    ).toThrow();
  });
  test('OpenRouter Grok has depth; Kimi has a toggle and rejects fake depth', () => {
    const p = new OpenAIProvider({ name: 'openrouter', apiKey: 'fake' });
    expect(p.buildKwargs(req('x-ai/grok-4.6', 'high')).reasoning).toEqual({
      effort: 'high',
    });
    expect(p.buildKwargs(req('x-ai/grok-4.6', 'off')).reasoning).toBeUndefined();
    expect(p.buildKwargs(req('moonshotai/kimi-k2.5', 'high')).reasoning).toEqual({ enabled: true });
    expect(p.buildKwargs(req('moonshotai/kimi-k2.5', 'off')).reasoning).toEqual({ enabled: false });
    expect(() => p.buildKwargs(req('moonshotai/kimi-k2.5', 'low'))).toThrow();
    expect(() =>
      validateRouteSelection(getRoute('openrouter-api'), {
        model: 'moonshotai/kimi-k2.5',
        effort: 'max',
      }),
    ).toThrow();
  });
  test('future arbitrary IDs consume exact metadata; stale/cross-route metadata rejects', () => {
    const p = new OpenAIProvider({ name: 'openrouter', apiKey: 'fake' });
    const record: ModelRecord = {
      id: 'new-author/new-generation',
      displayName: 'Future',
      provider: 'openrouter',
      routeId: 'openrouter-api',
      auth: 'api_key',
      capabilities: {
        reasoning: 'supported',
        images: 'unknown',
        tools: 'unknown',
        textOutput: 'supported',
      },
      availability: 'advertised',
      metadata: { source: 'fixture', stale: false },
      efforts: ['off', 'high'],
      reasoningControl: { parameter: 'openrouter', disableSupported: false },
    };
    expect(p.buildKwargs({ ...req(record.id, 'high'), modelMetadata: record }).reasoning).toEqual({
      effort: 'high',
    });
    expect(() =>
      p.buildKwargs({
        ...req(record.id, 'high'),
        modelMetadata: {
          ...record,
          metadata: { ...record.metadata, stale: true },
        },
      }),
    ).toThrow();
    expect(() => p.buildKwargs({ ...req('other/model', 'high'), modelMetadata: record })).toThrow();
  });
});

test('refresh unknown leaves established OpenAI control intact but never invents a new control', () => {
  const metadata: ModelRecord = {
    id: 'gpt-5',
    displayName: 'GPT5',
    provider: 'openai',
    routeId: 'openai-api',
    auth: 'api_key',
    capabilities: {
      textOutput: 'supported',
      tools: 'unknown',
      images: 'unknown',
      reasoning: 'unknown',
    },
    availability: 'advertised',
    metadata: { source: 'provider-models-api', stale: false },
  };
  const p = new OpenAIProvider({ name: 'openai', apiKey: 'fake' });
  expect(
    p.buildKwargs({ ...req(metadata.id, 'high'), modelMetadata: metadata }).reasoning_effort,
  ).toBe('high');
  expect(
    validateRouteSelection(getRoute('openai-api'), {
      model: metadata.id,
      effort: 'high',
      modelMetadata: metadata,
    }).effort,
  ).toBe('high');
  const unknown = { ...metadata, id: 'future-unknown-model' };
  expect(() => p.buildKwargs({ ...req(unknown.id, 'high'), modelMetadata: unknown })).toThrow();
  expect(() =>
    p.buildKwargs({
      ...req(metadata.id, 'high'),
      modelMetadata: {
        ...metadata,
        capabilities: { ...metadata.capabilities, reasoning: 'unsupported' },
      },
    }),
  ).toThrow();
});

test('native API no-control remains valid when published depth list omits off', () => {
  const metadata: ModelRecord = {
    id: 'future/reasoning',
    displayName: 'Future',
    provider: 'openrouter',
    routeId: 'openrouter-api',
    auth: 'api_key',
    capabilities: {
      textOutput: 'supported',
      tools: 'unknown',
      images: 'unknown',
      reasoning: 'supported',
    },
    availability: 'advertised',
    metadata: { source: 'publisher', stale: false },
    efforts: ['high'],
  };
  const p = new OpenAIProvider({ name: 'openrouter', apiKey: 'fake' });
  expect(
    validateRouteSelection(getRoute('openrouter-api'), {
      model: metadata.id,
      modelMetadata: metadata,
    }).effort,
  ).toBe('off');
  expect(
    p.buildKwargs({ ...req(metadata.id, 'off'), modelMetadata: metadata }).reasoning,
  ).toBeUndefined();
});

test('fresh future OpenAI reasoning controls select completion token cap and omit temperature', () => {
  const metadata: ModelRecord = {
    id: 'future-exact',
    provider: 'openai',
    routeId: 'openai-api',
    auth: 'api_key',
    displayName: 'Future',
    availability: 'advertised',
    efforts: ['off', 'high'],
    capabilities: {
      textOutput: 'supported',
      tools: 'unknown',
      images: 'unknown',
      reasoning: 'supported',
    },
    metadata: { source: 'fixture', stale: false },
    reasoningControl: { parameter: 'openai', disableSupported: false },
  };
  const body = new OpenAIProvider({
    name: 'openai',
    apiKey: 'fake',
  }).buildKwargs({
    ...req(metadata.id, 'high'),
    modelMetadata: metadata,
    temperature: 0.5,
  });
  expect(body.reasoning_effort).toBe('high');
  expect(body.max_completion_tokens).toBe(2048);
  expect(body.max_tokens).toBeUndefined();
  expect(body.temperature).toBeUndefined();
});
