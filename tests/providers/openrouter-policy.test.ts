import { describe, expect, test } from 'bun:test';
import { SettingsSchema } from '@yevgetman/sov-sdk/config/schema';
import { OpenAIProvider } from '@yevgetman/sov-sdk/providers/openai';
import { validateOpenRouterPolicy } from '@yevgetman/sov-sdk/providers/openrouterPolicy';
import { resolveProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

const req: ProviderRequest = {
  model: 'author/future-model',
  messages: [],
  system: [],
  maxTokens: 1024,
};
const pinned = {
  only: ['future-host/endpoint'],
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: 'deny' as const,
  zdr: true,
};

describe('OpenRouter inference policy', () => {
  test('pins a host exactly and retains restrictive settings in the request', () => {
    const provider = new OpenAIProvider({
      apiKey: 'fixture',
      name: 'openrouter',
      openrouterPolicy: pinned,
    });
    expect(provider.buildKwargs(req).provider).toEqual(pinned);
    expect(provider.buildKwargs(req).model).toBe('author/future-model');
  });
  test('default request has no routing object and native transport rejects policy', () => {
    expect(
      new OpenAIProvider({ apiKey: 'fixture', name: 'openrouter' }).buildKwargs(req),
    ).not.toHaveProperty('provider');
    for (const name of ['openai', 'xai', 'sov']) {
      expect(
        () => new OpenAIProvider({ apiKey: 'fixture', name, openrouterPolicy: pinned }),
      ).toThrow('requires openrouter');
    }
  });
  test('rejects malformed and contradictory policy without widening it', () => {
    for (const policy of [
      { only: [] },
      { only: [''] },
      { only: ['a'], ignore: ['a'] },
      { only: ['a'], order: ['b'] },
      { unknown: true },
    ]) {
      expect(() => validateOpenRouterPolicy(policy as never)).toThrow();
    }
  });
  test('settings accept policy only in OpenRouter configuration and resolver retains it', () => {
    const settings = SettingsSchema.parse({
      providers: { openrouter: { apiKey: 'fixture', routing: pinned } },
    });
    const resolved = resolveProvider('openrouter', req.model, { settings, env: {} });
    expect((resolved.transport.buildKwargs(req) as { provider?: unknown }).provider).toEqual(
      pinned,
    );
    expect(() => SettingsSchema.parse({ providers: { xai: { routing: pinned } } })).toThrow();
  });
  test('unavailable pinned host fails without a fallback request', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAIProvider({
      apiKey: 'fixture',
      name: 'openrouter',
      openrouterPolicy: pinned,
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{"error":{"message":"No endpoints found"}}', { status: 404 });
      }) as typeof fetch,
    });
    await expect(
      (async () => {
        for await (const event of provider.stream(req)) void event;
      })(),
    ).rejects.toThrow();
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { provider: unknown }).provider).toEqual(pinned);
  });
});
