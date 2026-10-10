import { expect, test } from 'bun:test';
import {
  createMemoryModelCatalogCache,
  createModelDiscovery,
} from '../../../packages/sdk/src/providers/models/catalog.js';
import {
  type DirectModelSourceOptions,
  createDirectModelSource,
  createSubscriptionModelSource,
  normalizeDirectModel,
  resolveModelAlias,
} from '../../../packages/sdk/src/providers/models/direct.js';
import { OpenAIProvider } from '../../../packages/sdk/src/providers/openai.js';

test('direct discovery uses explicit route credentials with account-isolated caches', async () => {
  const calls: Array<{ url: string; headers: unknown }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers });
    return Response.json({ data: [{ id: calls.length === 1 ? 'future-1' : 'future-2' }] });
  }) as unknown as typeof globalThis.fetch;
  const discovery = createModelDiscovery({ fetch, cache: createMemoryModelCatalogCache() });
  const sourceA = createDirectModelSource({
    provider: 'openai',
    apiKey: 'callerA',
    accountId: 'a',
  });
  const sourceB = createDirectModelSource({
    provider: 'openai',
    apiKey: 'callerB',
    accountId: 'b',
  });
  await discovery.refresh(sourceA);
  expect((await discovery.read(sourceB)).state).toBe('unavailable');
  await discovery.refresh(sourceB);
  expect(calls[0]?.headers).toEqual({ Authorization: 'Bearer callerA' });
  expect((await discovery.read(sourceA)).models[0]?.id).toBe('future-1');
  expect((await discovery.read(sourceB)).models[0]?.id).toBe('future-2');
});
test('subscription catalogs never copy API account availability or make credential reads', async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    throw Error('must not fetch');
  }) as unknown as typeof globalThis.fetch;
  for (const routeId of ['grok-subscription', 'chatgpt-subscription'] as const) {
    const catalog = await createModelDiscovery({ fetch }).refresh(
      createSubscriptionModelSource(routeId),
    );
    expect(catalog.state).toBe('unavailable');
    expect(catalog.fetchedAt).toBeUndefined();
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models.every((model) => model.metadata.stale)).toBe(true);
    expect(catalog.models.every((model) => model.availability === 'unknown')).toBe(true);
    expect(catalog.models.every((model) => model.auth === 'subscription')).toBe(true);
  }
  expect(calls).toBe(0);
});
test('explicit aliases resolve exact IDs without changing default or routes', () => {
  expect(resolveModelAlias('chosen', { chosen: 'future-2028' })).toBe('future-2028');
  expect(resolveModelAlias('caller-id')).toBe('caller-id');
  expect(() => resolveModelAlias('a', { a: 'b', b: 'a' })).toThrow('cycle');
  expect(() => createDirectModelSource({ provider: 'xai', apiKey: '', accountId: 'a' })).toThrow(
    'Explicit',
  );
});
test('Anthropic cursor pagination and unknown metadata remain honest', async () => {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    expect(init?.headers).toEqual({ 'x-api-key': 'key', 'anthropic-version': '2023-06-01' });
    return Response.json(
      urls.length === 1
        ? { data: [{ id: 'claude-future' }], has_more: true }
        : { data: [{ id: 'claude-next' }], has_more: false },
    );
  }) as unknown as typeof globalThis.fetch;
  const catalog = await createModelDiscovery({ fetch }).refresh(
    createDirectModelSource({ provider: 'anthropic', apiKey: 'key', accountId: 'a' }),
  );
  expect(urls[1]).toContain('after_id=claude-future');
  expect(catalog.models[0]?.capabilities.images).toBe('unknown');
  expect(catalog.models[0]?.contextWindow).toBeUndefined();
});

test('publisher-provided limits and xAI modalities grow without model-name guesses', async () => {
  const fetch = (async () =>
    Response.json({
      models: [
        {
          id: 'future-2040',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          context_window: 8_000_000,
          max_output_tokens: 600_000,
          capabilities: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'] },
        },
        { id: 'video-only', output_modalities: ['video'] },
      ],
    })) as unknown as typeof globalThis.fetch;
  const catalog = await createModelDiscovery({ fetch }).refresh(
    createDirectModelSource({ provider: 'xai', apiKey: 'key', accountId: 'a' }),
  );
  expect(catalog.models.map((model) => model.id)).toEqual(['future-2040']);
  expect(catalog.models[0]?.contextWindow).toBe(8_000_000);
  expect(catalog.models[0]?.capabilities.images).toBe('supported');
  expect(catalog.models[0]?.efforts).toEqual(['off', 'low', 'medium', 'high', 'max']);
});

test('future direct effort metadata preserves exact published max wire enums', () => {
  for (const provider of ['openai', 'xai'] as const) {
    for (const maxWireValue of ['xhigh', 'max']) {
      const metadata = normalizeDirectModel(
        { id: 'future-exact', capabilities: { reasoning_effort: ['low', 'high', maxWireValue] } },
        provider,
      );
      expect(metadata?.reasoningControl?.maxWireValue).toBe(maxWireValue);
      if (!metadata) throw new Error('fixture model did not normalize');
      const body = new OpenAIProvider({ name: provider, apiKey: 'fake' }).buildKwargs({
        model: metadata.id,
        modelMetadata: metadata,
        system: [],
        messages: [],
        maxTokens: 4096,
        temperature: 0.5,
        effort: 'max',
      });
      expect(body.reasoning_effort).toBe(maxWireValue);
      if (provider === 'openai') {
        expect(body.max_completion_tokens).toBe(4096);
        expect(body.max_tokens).toBeUndefined();
        expect(body.temperature).toBeUndefined();
      } else {
        expect(body.max_tokens).toBe(4096);
        expect(body.temperature).toBe(0.5);
      }
    }
  }
});

test('unknown direct effort vocabulary never invents an adapter control', () => {
  const model = normalizeDirectModel(
    {
      id: 'future-unknown',
      capabilities: { reasoning_effort: ['publisher-unrecognized-control'] },
    },
    'openai',
  );
  expect(model?.capabilities.reasoning).toBe('unknown');
  expect(model?.reasoningControl).toBeUndefined();
  expect(model?.efforts).toBeUndefined();
});

test('Anthropic published effort flags and thinking modes survive refresh for new IDs', async () => {
  const fetch = (async () =>
    Response.json({
      data: [
        {
          id: 'claude-next-2040',
          capabilities: {
            thinking: {
              supported: true,
              types: { enabled: { supported: false }, adaptive: { supported: true } },
            },
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: false },
              high: { supported: true },
              max: { supported: false },
            },
          },
        },
      ],
    })) as unknown as typeof globalThis.fetch;
  const discovery = createModelDiscovery({ fetch });
  const source = createDirectModelSource({ provider: 'anthropic', apiKey: 'fake', accountId: 'a' });
  for (const result of [await discovery.refresh(source), await discovery.read(source)]) {
    expect(result.models[0]?.efforts).toEqual(['off', 'low', 'high']);
    expect(result.models[0]?.anthropicThinkingModes).toEqual(['adaptive']);
    expect(result.models[0]?.anthropicEffortSupported).toBe(true);
    expect(result.models[0]?.capabilities.reasoning).toBe('supported');
  }
  const disabled = normalizeDirectModel(
    {
      id: 'claude-next-disabled',
      capabilities: {
        thinking: {
          supported: false,
          types: { enabled: { supported: false }, adaptive: { supported: false } },
        },
        effort: { supported: false },
      },
    },
    'anthropic',
  );
  expect(disabled?.efforts).toEqual(['off']);
  expect(disabled?.anthropicThinkingModes).toEqual([]);
  expect(disabled?.capabilities.reasoning).toBe('unsupported');
  const partial = normalizeDirectModel(
    { id: 'claude-next-partial', capabilities: { thinking: { supported: true } } },
    'anthropic',
  );
  expect(partial?.efforts).toBeUndefined();
  expect(partial?.anthropicThinkingModes).toBeUndefined();
});

test('Anthropic output effort and enabled thinking are independent published facts', async () => {
  const fetch = (async () =>
    Response.json({
      data: [
        {
          id: 'claude-budget-only',
          capabilities: {
            thinking: {
              supported: true,
              types: { enabled: { supported: true }, adaptive: { supported: false } },
            },
            effort: { supported: false },
          },
        },
      ],
    })) as unknown as typeof globalThis.fetch;
  const catalog = await createModelDiscovery({ fetch }).refresh(
    createDirectModelSource({ provider: 'anthropic', apiKey: 'fake', accountId: 'a' }),
  );
  expect(catalog.models[0]?.capabilities.reasoning).toBe('supported');
  expect(catalog.models[0]?.anthropicThinkingModes).toEqual(['enabled']);
  expect(catalog.models[0]?.anthropicEffortSupported).toBe(false);
  expect(catalog.models[0]?.efforts).toEqual(['off']);
});

test('direct sources freeze endpoint, credentials and account identity before host mutations', async () => {
  for (const provider of ['openai', 'anthropic'] as const) {
    const options: DirectModelSourceOptions = {
      provider,
      apiKey: 'fake-original-secret',
      accountId: 'original-account',
    };
    const source = createDirectModelSource(options);
    options.provider = 'xai';
    options.apiKey = 'fake-replacement-secret';
    options.accountId = 'replacement-account';
    let calls = 0;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(String(url)).toStartWith(`https://api.${provider}.com/v1/models`);
      expect(init?.headers).toEqual(
        provider === 'anthropic'
          ? { 'x-api-key': 'fake-original-secret', 'anthropic-version': '2023-06-01' }
          : { Authorization: 'Bearer fake-original-secret' },
      );
      // Mutate again while fetching. Continuation pages and normalization must
      // retain the same construction identity as the first request.
      options.provider = provider === 'openai' ? 'anthropic' : 'openai';
      return Response.json({
        data: [{ id: `future-${calls}` }],
        ...(calls === 1 ? { next: '?page=2' } : {}),
      });
    }) as unknown as typeof globalThis.fetch;
    const discovery = createModelDiscovery({ fetch });
    const catalog = await discovery.refresh(source);
    expect(catalog.state).toBe('current');
    expect(calls).toBe(2);
    expect(source.routeId).toBe(`${provider}-api`);
    expect(source.cacheKey).toBe('original-account');
    expect(catalog.models.map((model) => model.provider)).toEqual([provider, provider]);
    expect(catalog.models.map((model) => model.routeId)).toEqual([
      `${provider}-api`,
      `${provider}-api`,
    ]);
  }
});
