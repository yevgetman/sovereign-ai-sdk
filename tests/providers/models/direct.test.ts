import { expect, test } from 'bun:test';
import {
  createMemoryModelCatalogCache,
  createModelDiscovery,
} from '../../../packages/sdk/src/providers/models/catalog.js';
import {
  createDirectModelSource,
  createSubscriptionModelSource,
  resolveModelAlias,
} from '../../../packages/sdk/src/providers/models/direct.js';

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
