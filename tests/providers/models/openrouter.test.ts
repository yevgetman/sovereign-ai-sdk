import { expect, test } from 'bun:test';
import { createModelDiscovery } from '../../../packages/sdk/src/providers/models/catalog.js';
import {
  createOpenRouterModelSource,
  normalizeOpenRouterModel,
} from '../../../packages/sdk/src/providers/models/openrouter.js';

test('OpenRouter normalizes unknowns, exact author, growing windows and generation-only exclusions', () => {
  const record = normalizeOpenRouterModel({
    id: 'new-author/model-9',
    context_length: 10_000_000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    top_provider: { max_completion_tokens: 1_000_000 },
    supported_parameters: ['tools', 'reasoning'],
    pricing: { prompt: '0.000001', completion: '0.000002' },
  });
  expect(record?.contextWindow).toBe(10_000_000);
  expect(record?.pricing?.inputPerMillion).toBe(1);
  expect(record?.capabilities.reasoning).toBe('supported');
  expect(record?.efforts).toBeUndefined();
  expect(record?.inferenceHost).toBeUndefined();
  expect(
    normalizeOpenRouterModel({ id: 'image-only', architecture: { output_modalities: ['image'] } }),
  ).toBeUndefined();
  expect(normalizeOpenRouterModel({ id: 'unknown' })?.capabilities.images).toBe('unknown');
});
test('OpenRouter follows bounded same-origin pagination and cache survives failed refresh', async () => {
  let fail = false;
  const fetch = (async (url: string | URL | Request) => {
    if (fail) throw Error('offline');
    return Response.json(
      String(url).endsWith('page=2')
        ? { data: [{ id: 'b/model', architecture: { output_modalities: ['text'] } }] }
        : {
            data: [{ id: 'a/model', architecture: { output_modalities: ['text'] } }],
            next: '?page=2',
          },
    );
  }) as unknown as typeof globalThis.fetch;
  const discovery = createModelDiscovery({ fetch });
  const source = createOpenRouterModelSource();
  expect((await discovery.refresh(source)).models.map((model) => model.id)).toEqual([
    'a/model',
    'b/model',
  ]);
  fail = true;
  expect((await discovery.refresh(source)).state).toBe('stale');
});
test('pagination never follows off-origin locations', async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    return Response.json({ data: [], next: 'https://attacker.example/models' });
  }) as unknown as typeof globalThis.fetch;
  expect((await createModelDiscovery({ fetch }).refresh(createOpenRouterModelSource())).state).toBe(
    'unavailable',
  );
  expect(calls).toBe(1);
});

test('bounded response refuses oversized declarations and streamed bytes', async () => {
  for (const mode of ['length', 'stream']) {
    const fetch = (async () =>
      mode === 'length'
        ? new Response('{}', { headers: { 'content-length': '20000000' } })
        : new Response(new Uint8Array(16 * 1024 * 1024 + 1))) as unknown as typeof globalThis.fetch;
    expect(
      (await createModelDiscovery({ fetch }).refresh(createOpenRouterModelSource())).state,
    ).toBe('unavailable');
  }
});
