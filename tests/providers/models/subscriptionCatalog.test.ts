import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSubscriptionModelSource,
  normalizeDirectModel,
} from '@yevgetman/sov-sdk/providers/models/direct';
import {
  SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE,
  applySubscriptionAccountCatalog,
  normalizeSubscriptionCatalogRow,
  presentSubscriptionCatalog,
  reportSubscriptionPin,
  selectableSubscriptionEfforts,
  subscriptionAccountModelCatalog,
  subscriptionToolsSelectable,
  withSelectableSubscriptionEfforts,
} from '@yevgetman/sov-sdk/providers/models/subscriptionCatalog';
import type { ModelCatalog, ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import { validateModelRequest } from '@yevgetman/sov-sdk/providers/models/validateRequest';
import { RouteError } from '@yevgetman/sov-sdk/providers/routes/errors';
import {
  SUBSCRIPTION_ROUTE_EFFORTS,
  getRoute,
  validateRouteSelection,
} from '@yevgetman/sov-sdk/providers/routes/index';
import {
  loginSubscription,
  logoutSubscription,
} from '@yevgetman/sov-sdk/providers/subscription/login';
import { SUBSCRIPTION_DEFAULT_MODEL } from '@yevgetman/sov-sdk/providers/subscription/names';
import type { SubscriptionCredentialPort } from '@yevgetman/sov-sdk/providers/subscription/port';
import {
  GROK_SUBSCRIPTION_PIN_SOURCE,
  grokSubscriptionPin,
} from '../../../packages/sdk/src/providers/models/grokPin.js';
import {
  createModelDiscovery,
  fallbackModelCatalog,
} from '../../../packages/sdk/src/providers/models/index.js';
import {
  clearSubscriptionCatalogCache,
  diskModelCache,
  modelPage,
  modelSource,
  readModelCatalog,
  readModelCatalogSnapshot,
  subscriptionSessionHooks,
} from '../../../src/cli/modelDiscovery.js';
import { modelDetails } from '../../../src/config/modelSuggestions.js';

const TOKEN_MATERIAL = /authorization|bearer|\bsk-|access_token|refresh_token/i;
const listedAt = () => new Date(Date.now() - 60_000).toISOString();

function omittedEffort(
  route: ReturnType<typeof getRoute>,
  input: Parameters<typeof validateRouteSelection>[1],
): string {
  try {
    return validateRouteSelection(route, input).effort;
  } catch (error) {
    if (error instanceof RouteError) return error.code;
    throw error;
  }
}

function request(model: string, extras: Record<string, unknown> = {}) {
  return {
    model,
    system: [],
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    maxTokens: 16,
    ...extras,
  };
}

function memoryPort(): SubscriptionCredentialPort {
  let current: { accessToken: string; refreshToken: string; expiresAt: number } | null = null;
  return {
    async read() {
      return current ? { ...current } : null;
    },
    async write(_service, next) {
      current = { ...next };
    },
    async delete() {
      current = null;
    },
  };
}

const silentIo = {
  stdout: () => {},
  stderr: () => {},
  openUrl: () => {},
  sleep: async () => {},
  now: () => 1_800_000_000_000,
  fetchImpl: async () => {
    throw new Error('login fixture must stub fetch');
  },
};

function diskShape(
  routeId: 'chatgpt-subscription' | 'grok-subscription',
  models: ModelRecord[],
  at = listedAt(),
): ModelCatalog {
  return { version: 1, routeId, state: 'current', fetchedAt: at, models };
}

describe('subscription catalog policy', () => {
  test('missing endpoint throws and performs zero fetches', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      throw new Error('must not fetch');
    }) as unknown as typeof globalThis.fetch;
    for (const routeId of ['grok-subscription', 'chatgpt-subscription'] as const) {
      const source = createSubscriptionModelSource(routeId);
      expect(source.cacheKey).toBe(
        routeId === 'grok-subscription'
          ? 'SOV_SUB_GROK:SOV_SUB_GROK'
          : 'SOV_SUB_CHATGPT:SOV_SUB_CHATGPT',
      );
      expect(source.cacheKey).not.toContain('public');
      const catalog = await createModelDiscovery({ fetch }).refresh(source);
      expect(catalog.state).toBe('unavailable');
      expect(catalog.fetchedAt).toBeUndefined();
      if (routeId === 'grok-subscription') {
        expect(catalog.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6']);
        expect(
          catalog.models.every((model) => model.metadata.source === GROK_SUBSCRIPTION_PIN_SOURCE),
        ).toBe(true);
      } else {
        expect(
          catalog.models.every((model) => model.metadata.source === 'bundled-suggestions'),
        ).toBe(true);
      }
      await expect(
        source.discover({ fetch, signal: new AbortController().signal }),
      ).rejects.toThrow('Subscription model discovery unavailable');
    }
    expect(calls).toBe(0);
    expect(createSubscriptionModelSource('grok-subscription').discover.toString()).not.toContain(
      'http',
    );
    const policy = readFileSync('packages/sdk/src/providers/models/subscriptionCatalog.ts', 'utf8');
    expect(policy).not.toContain('api.x.ai');
    expect(policy).not.toContain('api.openai.com');
    expect(policy).not.toContain('api.anthropic.com');
    expect(() => createSubscriptionModelSource('grok-subscription', 'public')).toThrow(
      /non-secret/,
    );
    expect(() => createSubscriptionModelSource('grok-subscription', 'sk-live')).toThrow(
      /non-secret/,
    );
    expect(() => createSubscriptionModelSource('chatgpt-subscription', 'access_token')).toThrow(
      /non-secret/,
    );
  });

  test('401, 403, and empty bodies are not current and do not copy an API catalog', () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
    };
    const apiBody = {
      models: [
        {
          id: 'grok-9',
          auth: 'api_key',
          availability: 'advertised',
          pricing: { currency: 'USD', source: 'api', inputPerMillion: 1 },
          context_window: 50_000,
          capabilities: { tools: true, reasoning_effort: ['high'] },
          access_token: 'access_token should-not-stick',
        },
      ],
    };
    for (const status of [401, 403] as const) {
      const applied = applySubscriptionAccountCatalog('grok-subscription', {
        status,
        body: apiBody,
      });
      expect(applied.state).not.toBe('current');
      expect(applied.cacheableCurrent).toBe(false);
      expect(applied.defaultModel).toBe('grok-4.7');
      expect(applied.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6']);
      expect(applied.models.every((model) => model.auth === 'subscription')).toBe(true);
      expect(
        applied.models.every((model) => model.metadata.source === GROK_SUBSCRIPTION_PIN_SOURCE),
      ).toBe(true);
      expect(applied.models.every((model) => model.availability === 'unknown')).toBe(true);
      expect(JSON.stringify(applied)).not.toContain('grok-9');
      expect(TOKEN_MATERIAL.test(JSON.stringify(applied))).toBe(false);
    }
    const empty = applySubscriptionAccountCatalog('chatgpt-subscription', {
      status: 200,
      body: { data: [] },
    });
    expect(empty.state).toBe('unavailable');
    expect(empty.cacheableCurrent).toBe(false);
    expect(empty.defaultModel).toBe('gpt-5.3-codex');
    expect(empty.models.map((model) => model.id)).toEqual(['gpt-5.3-codex']);
    expect(fetch).toBeTypeOf('function');
    expect(calls).toBe(0);
  });

  test('a retired pin that is the only row is unavailable and not listed again', () => {
    expect(SUBSCRIPTION_DEFAULT_MODEL.grok).toBe('grok-4.7');
    const retired = applySubscriptionAccountCatalog('grok-subscription', {
      status: 200,
      listedAt: listedAt(),
      body: {
        models: [{ id: 'grok-4.7', lifecycle: 'retired', output_modalities: ['text'] }],
      },
    });
    expect(retired.state).toBe('unavailable');
    expect(retired.pinnedDefaultUnavailable).toBe(true);
    expect(retired.models.map((model) => model.id)).not.toContain('grok-4.7');
    expect(retired.models.map((model) => model.id)).toContain('grok-4.6');
    const stored = subscriptionAccountModelCatalog(retired);
    expect(stored.pinnedDefault).toEqual({ id: 'grok-4.7', status: 'unavailable' });
    expect(stored.models.map((model) => model.id)).not.toContain('grok-4.7');
    expect(reportSubscriptionPin(stored)).toEqual({ id: 'grok-4.7', status: 'unavailable' });
    const page = modelPage(stored, { route: 'grok-subscription' });
    expect((page as { error?: { code?: string } }).error?.code).toBe('pinned_default_unavailable');
    expect(page.models.map((model) => model.id)).not.toContain('grok-4.7');

    for (const input of [
      { status: 401, body: { models: [{ id: 'grok-4.7', output_modalities: ['text'] }] } },
      { status: 200, body: { models: [] } },
    ]) {
      const ordinary = applySubscriptionAccountCatalog('grok-subscription', input);
      expect(ordinary.state).toBe('unavailable');
      expect(ordinary.pinnedDefaultUnavailable).toBe(false);
      expect(ordinary.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6']);
      const catalog = subscriptionAccountModelCatalog(ordinary);
      expect(catalog.pinnedDefault).toBeUndefined();
      expect(reportSubscriptionPin(catalog)).toBeUndefined();
      const ordinaryPage = modelPage(catalog, { route: 'grok-subscription' });
      expect((ordinaryPage as { error?: { code?: string } }).error?.code).not.toBe(
        'pinned_default_unavailable',
      );
    }
  });

  test('retired and non-text rows drop and a retired pin is not replaced', () => {
    const applied = applySubscriptionAccountCatalog('grok-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          { id: 'grok-4.7', lifecycle: 'retired', output_modalities: ['text'] },
          { id: 'grok-video', output_modalities: ['video'], capabilities: { tools: true } },
          {
            id: 'grok-4.6',
            output_modalities: ['text'],
            capabilities: { tools: true },
            max_input_tokens: 128_000,
          },
        ],
      },
    });
    expect(applied.state).toBe('current');
    expect(applied.models.map((model) => model.id)).toEqual(['grok-4.6']);
    expect(applied.defaultModel).toBe('grok-4.7');
    expect(applied.pinnedDefaultUnavailable).toBe(true);
    expect(applied.missingPinnedDefault).toBe(false);
    expect(applied.models[0]?.contextWindow).toBe(128_000);
    expect(applied.models[0]?.capabilities.tools).toBe('supported');
  });

  test('missing capabilities stay unknown and a prefix copies nothing', () => {
    const applied = applySubscriptionAccountCatalog('grok-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          {
            id: 'grok-4.6',
            output_modalities: ['text'],
            input_modalities: ['text', 'image'],
            context_window: 100_000,
            capabilities: { tools: true, reasoning_effort: ['low', 'xhigh'] },
            pricing: { currency: 'USD', source: 'api-key', inputPerMillion: 3 },
          },
          { id: 'grok-4.7', output_modalities: ['text'] },
          { id: 'gpt-6.1-sol', output_modalities: ['text'] },
        ],
      },
    });
    const older = applied.models.find((model) => model.id === 'grok-4.6');
    const newer = applied.models.find((model) => model.id === 'grok-4.7');
    const foreign = applied.models.find((model) => model.id === 'gpt-6.1-sol');
    if (!older || !newer || !foreign) throw new Error('missing fixture row');
    expect(newer.capabilities).toEqual({
      textOutput: 'supported',
      tools: 'unknown',
      images: 'unknown',
      reasoning: 'unknown',
    });
    expect(newer.efforts).toBeUndefined();
    expect(newer.contextWindow).toBeUndefined();
    expect(newer.pricing).toBeUndefined();
    expect(newer.auth).toBe('subscription');
    expect(newer.routeId).toBe('grok-subscription');
    expect(newer.availability).toBe('account');
    expect(newer.metadata.source).toBe(SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE);
    expect(older.capabilities.tools).toBe('supported');
    expect(older.contextWindow).toBe(100_000);
    expect(older.efforts).toEqual(['off', 'low', 'max']);
    expect(older.pricing).toBeUndefined();
    expect(older.reasoningControl).toBeUndefined();
    expect(newer.capabilities).not.toEqual(older.capabilities);
    expect(foreign.capabilities.tools).toBe('unknown');
    expect(foreign.contextWindow).toBeUndefined();
    expect(subscriptionToolsSelectable(newer, applied.state)).toBe(false);
    expect(() =>
      validateModelRequest(
        request(newer.id, { tools: [{ name: 'run', description: 'run', input_schema: {} }] }),
        'grok',
        newer,
      ),
    ).toThrow(/unknown/i);
    expect(
      subscriptionToolsSelectable(
        { ...newer, capabilities: { ...newer.capabilities, tools: 'supported' } },
        'stale',
      ),
    ).toBe(false);
    const armed = applied.models[0];
    if (!armed) throw new Error('missing armed row');
    expect(subscriptionToolsSelectable(armed, 'current')).toBe(true);
    expect(() =>
      validateModelRequest(
        request(armed.id, { tools: [{ name: 'run', description: 'run', input_schema: {} }] }),
        'grok',
        armed,
      ),
    ).not.toThrow();
    expect(() =>
      validateModelRequest(
        request(armed.id, { tools: [{ name: 'run', description: 'run', input_schema: {} }] }),
        'grok',
        { ...armed, metadata: { ...armed.metadata, stale: true } },
      ),
    ).toThrow(/unknown/i);
  });

  test('an API-shaped record and a direct sibling do not donate subscription capabilities', () => {
    const direct = normalizeDirectModel(
      {
        id: 'grok-4.6',
        context_window: 200_000,
        capabilities: { tools: true, reasoning_effort: ['high'] },
      },
      'xai',
    );
    const copied = normalizeSubscriptionCatalogRow(
      {
        ...direct,
        auth: 'api_key',
        availability: 'advertised',
        contextWindow: 200_000,
        efforts: ['off', 'high'],
        pricing: {
          currency: 'USD',
          source: 'https://api.x.ai/v1/language-models',
          inputPerMillion: 1,
        },
        reasoningControl: { parameter: 'xai', disableSupported: false, maxWireValue: 'xhigh' },
        metadata: { source: 'https://api.x.ai/v1/language-models', stale: false },
      },
      'grok-subscription',
      { accountCatalog: true },
    );
    expect(copied?.auth).toBe('subscription');
    expect(copied?.routeId).toBe('grok-subscription');
    expect(copied?.provider).toBe('grok');
    expect(copied?.availability).toBe('account');
    expect(copied?.capabilities.tools).toBe('unknown');
    expect(copied?.contextWindow).toBeUndefined();
    expect(copied?.efforts).toBeUndefined();
    expect(copied?.pricing).toBeUndefined();
    expect(copied?.reasoningControl).toBeUndefined();
    expect(JSON.stringify(copied)).not.toContain('api.x.ai');
    const bare = normalizeSubscriptionCatalogRow({ id: 'gpt-6.1-sol' }, 'chatgpt-subscription', {
      accountCatalog: false,
    });
    expect(bare?.availability).toBe('unknown');
    expect(bare?.metadata.source).not.toBe('bundled-suggestions');
  });

  test('published grok efforts are recorded and not selectable, and chatgpt does not inherit the pin', () => {
    const grok = applySubscriptionAccountCatalog('grok-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          {
            id: 'grok-4.7',
            output_modalities: ['text'],
            input_modalities: ['image'],
            capabilities: { reasoning_effort: ['low', 'high', 'xhigh'] },
          },
        ],
      },
    });
    const row = grok.models[0];
    if (!row) throw new Error('missing grok row');
    expect(grok.missingPinnedDefault).toBe(false);
    expect(grok.defaultModel).toBe(SUBSCRIPTION_DEFAULT_MODEL.grok);
    expect(row.efforts).toEqual(['off', 'low', 'high', 'max']);
    expect(row.capabilities.images).toBe('supported');
    expect(selectableSubscriptionEfforts(row)).toEqual(['low', 'high', 'max']);
    const route = getRoute('grok-subscription');
    expect(validateRouteSelection(route, { model: 'grok-4.7', modelMetadata: row }).effort).toBe(
      'high',
    );
    expect(
      validateRouteSelection(route, { model: 'grok-4.7', effort: 'high', modelMetadata: row })
        .effort,
    ).toBe('high');
    expect(() =>
      validateRouteSelection(route, { model: 'grok-4.7', effort: 'off', modelMetadata: row }),
    ).toThrow(/effort_unsupported|not supported/);
    expect(() =>
      validateModelRequest(
        {
          ...request(row.id),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
                },
              ],
            },
          ],
        },
        'grok',
        row,
      ),
    ).toThrow(/image/i);
    expect(() => validateRouteSelection(route, { model: 'claude-sonnet' })).toThrow(
      /model_unsupported|not supported/,
    );

    const chatgpt = applySubscriptionAccountCatalog('chatgpt-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          { id: 'gpt-5.3-codex', output_modalities: ['text'] },
          {
            id: 'gpt-6.1-sol',
            output_modalities: ['text'],
            capabilities: { reasoning_effort: ['low'] },
          },
        ],
      },
    });
    const pin = chatgpt.models.find((model) => model.id === 'gpt-5.3-codex');
    const next = chatgpt.models.find((model) => model.id === 'gpt-6.1-sol');
    if (!pin || !next) throw new Error('missing chatgpt rows');
    expect(pin.efforts).toBeUndefined();
    expect(selectableSubscriptionEfforts(pin)).toEqual(['low', 'medium', 'high', 'max']);
    expect(selectableSubscriptionEfforts(next)).toEqual(['low']);
    const chat = getRoute('chatgpt-subscription');
    expect(
      validateRouteSelection(chat, { model: pin.id, effort: 'high', modelMetadata: pin }).effort,
    ).toBe('high');
    expect(() =>
      validateRouteSelection(chat, { model: pin.id, effort: 'off', modelMetadata: pin }),
    ).toThrow();
    expect(() =>
      validateRouteSelection(chat, { model: next.id, effort: 'high', modelMetadata: next }),
    ).toThrow();
    expect(validateRouteSelection(chat, { effort: 'high' }).effort).toBe('high');
    expect(getRoute('grok-subscription').modelsAuthoritative).toBe(true);
    expect(getRoute('chatgpt-subscription').modelsAuthoritative).toBe(false);
    expect(getRoute('grok-subscription').models).toEqual(['grok-4.7', 'grok-4.6']);
    expect(getRoute('chatgpt-subscription').models).toEqual(['gpt-5.3-codex']);
    expect(SUBSCRIPTION_DEFAULT_MODEL).toEqual({ chatgpt: 'gpt-5.3-codex', grok: 'grok-4.7' });
    const settings = {
      routes: { 'grok-subscription': { defaultModel: 'grok-4.6' } },
      providers: { xai: { model: 'grok-4.6' }, openai: { model: 'gpt-5.3-codex' } },
    };
    expect(settings.routes['grok-subscription'].defaultModel).toBe('grok-4.6');
    expect(settings.providers.xai.model).toBe('grok-4.6');
  });

  test('a non-pin chatgpt account row does not resolve an omitted effort to off', () => {
    const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
      status: 200,
      body: { models: [{ id: 'gpt-6.1-sol', output_modalities: ['text'] }] },
    });
    const row = applied.models.find((model) => model.id === 'gpt-6.1-sol');
    if (!row) throw new Error('missing chatgpt row');
    expect(selectableSubscriptionEfforts(row)).not.toEqual(['off']);
    const route = getRoute('chatgpt-subscription');
    const codex = ['low', 'medium', 'high', 'max'] as const;
    const resolved = omittedEffort(route, { model: row.id, modelMetadata: row });
    expect(
      resolved === 'effort_unsupported' || (codex as readonly string[]).includes(resolved),
    ).toBe(true);
    expect(resolved).not.toBe('off');

    const partial = applySubscriptionAccountCatalog('chatgpt-subscription', {
      status: 200,
      body: {
        models: [
          {
            id: 'gpt-6.1-sol',
            output_modalities: ['text'],
            capabilities: { reasoning_effort: ['low'] },
          },
        ],
      },
    });
    const partialRow = partial.models[0];
    if (!partialRow) throw new Error('missing partial chatgpt row');
    const missedDefault = omittedEffort(route, {
      model: partialRow.id,
      modelMetadata: partialRow,
    });
    expect(
      missedDefault === 'effort_unsupported' ||
        (codex as readonly string[]).includes(missedDefault),
    ).toBe(true);
    expect(missedDefault).not.toBe('off');

    const pin = applySubscriptionAccountCatalog('chatgpt-subscription', {
      status: 200,
      body: { models: [{ id: 'gpt-5.3-codex', output_modalities: ['text'] }] },
    }).models[0];
    if (!pin) throw new Error('missing pin');
    expect(selectableSubscriptionEfforts(pin)).toEqual(['low', 'medium', 'high', 'max']);
    expect(validateRouteSelection(route, { model: pin.id, modelMetadata: pin }).effort).toBe(
      route.defaultEffort,
    );
  });

  test('a subscription pin row does not authorize efforts for a different model', () => {
    const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
      status: 200,
      body: { models: [{ id: 'gpt-5.3-codex', output_modalities: ['text'] }] },
    });
    const pin = applied.models.find((model) => model.id === 'gpt-5.3-codex');
    if (!pin) throw new Error('missing pin');
    expect(pin.efforts).toBeUndefined();
    const route = getRoute('chatgpt-subscription');
    expect(() =>
      validateRouteSelection(route, {
        model: 'gpt-6.1-sol',
        effort: 'high',
        modelMetadata: pin,
      }),
    ).toThrow(/model metadata does not match request/);
    expect(() =>
      validateRouteSelection(route, {
        model: pin.id,
        effort: 'high',
        modelMetadata: { ...pin, provider: 'openai' },
      }),
    ).toThrow(/model metadata does not match request/);
    expect(
      validateRouteSelection(route, { model: pin.id, effort: 'high', modelMetadata: pin }).effort,
    ).toBe('high');
  });

  test('the operator catalog lists selectable grok efforts and keeps published levels stored', async () => {
    const applied = applySubscriptionAccountCatalog('grok-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          {
            id: 'grok-4.7',
            output_modalities: ['text'],
            capabilities: { reasoning_effort: ['low', 'high', 'xhigh'] },
          },
        ],
      },
    });
    const row = applied.models[0];
    if (!row?.efforts) throw new Error('missing grok efforts');
    expect(row.efforts).toContain('high');
    expect(row.efforts).toContain('max');
    expect(selectableSubscriptionEfforts(row)).toEqual(['low', 'high', 'max']);
    const catalog = subscriptionAccountModelCatalog(applied);
    const page = modelPage(catalog, { route: 'grok-subscription' });
    expect(page.models[0]?.efforts).toEqual(['low', 'high', 'max']);
    const route = getRoute('grok-subscription');
    expect(() =>
      validateRouteSelection(route, { model: row.id, effort: 'off', modelMetadata: row }),
    ).toThrow(/effort_unsupported|not supported/);
    expect(
      validateRouteSelection(route, { model: row.id, effort: 'high', modelMetadata: row }).effort,
    ).toBe('high');
    expect(row.efforts).toEqual(['off', 'low', 'high', 'max']);

    const home = mkdtempSync(join(tmpdir(), 'sov-sub-efforts-'));
    try {
      const cache = diskModelCache(join(home, 'model-catalog'));
      const source = createSubscriptionModelSource('grok-subscription');
      await cache.set(`${source.routeId}:${source.cacheKey}`, catalog);
      const snapshot = readModelCatalogSnapshot('grok-subscription', {}, home);
      expect(snapshot.models.find((model) => model.id === 'grok-4.7')?.efforts).toEqual([
        'low',
        'high',
        'max',
      ]);
      const stored = await cache.get(`${source.routeId}:${source.cacheKey}`);
      expect(stored?.models[0]?.efforts).toContain('high');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('subscription operator copy does not claim a verified image serializer', () => {
    const imageRequest = (model: string) => ({
      ...request(model),
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/png' as const,
                data: 'aGVsbG8=',
              },
            },
          ],
        },
      ],
    });
    for (const entry of [
      {
        routeId: 'grok-subscription' as const,
        provider: 'grok',
        id: 'grok-4.7',
      },
      {
        routeId: 'chatgpt-subscription' as const,
        provider: 'chatgpt',
        id: 'gpt-6.1-sol',
      },
    ]) {
      const applied = applySubscriptionAccountCatalog(entry.routeId, {
        listedAt: listedAt(),
        body: {
          models: [
            {
              id: entry.id,
              output_modalities: ['text'],
              input_modalities: ['image'],
            },
          ],
        },
      });
      const row = applied.models[0];
      if (!row) throw new Error('missing row');
      expect(row.capabilities.images).toBe('supported');
      const catalog = subscriptionAccountModelCatalog(applied);
      const page = modelPage(catalog, { route: entry.routeId });
      expect(page.models[0]?.capabilities.images).toBe('supported');
      expect(modelDetails(row)).toContain('images:supported');
      expect(modelDetails(row)).toMatch(/transport has no image serializer/i);
      expect(modelDetails(row)).toMatch(/cannot send images/i);
      expect(row.capabilities.images).toBe('supported');
      expect(catalog.models[0]?.capabilities.images).toBe('supported');
      expect(() => validateModelRequest(imageRequest(row.id), entry.provider, row)).toThrow(
        /no verified image serializer/,
      );
    }
    const direct: ModelRecord = {
      id: 'gpt-4o',
      displayName: 'gpt-4o',
      routeId: 'openai-api',
      provider: 'openai',
      auth: 'api_key',
      capabilities: {
        textOutput: 'supported',
        tools: 'supported',
        images: 'supported',
        reasoning: 'unknown',
      },
      availability: 'advertised',
      metadata: { source: 'direct-api', stale: false },
    };
    expect(modelDetails(direct)).toContain('images:supported');
    expect(modelDetails(direct)).not.toContain('no image serializer');
    const empty = modelPage(fallbackModelCatalog('chatgpt-subscription'), {
      route: 'chatgpt-subscription',
    });
    expect(empty.models.length).toBeGreaterThan(0);
    expect(empty.models.every((model) => model.capabilities.images === 'unknown')).toBe(true);
  });

  test('a failed refresh of a timestamped subscription catalog says it was left stale', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-sub-refresh-copy-'));
    try {
      const cache = diskModelCache(join(home, 'model-catalog'));
      const source = createSubscriptionModelSource('chatgpt-subscription');
      const at = listedAt();
      const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
        listedAt: at,
        body: {
          models: [
            {
              id: 'gpt-5.3-codex',
              output_modalities: ['text'],
              input_modalities: ['text', 'image'],
              capabilities: { tools: true },
            },
          ],
        },
      });
      const key = `${source.routeId}:${source.cacheKey}`;
      await cache.set(key, diskShape('chatgpt-subscription', applied.models, at));
      const refreshed = await readModelCatalog('chatgpt-subscription', {}, true, cache);
      const page = modelPage(refreshed, { route: 'chatgpt-subscription' });
      const message = (page as { error?: { message?: string } }).error?.message ?? '';
      expect(message).toMatch(/cannot fetch/i);
      expect(message).toMatch(/stored timestamped catalog was left stale/i);
      expect(message).not.toBe('Model discovery unavailable.');
      const saved = await cache.get(key);
      expect(saved?.state).toBe('stale');
      expect(saved?.state).not.toBe('current');
      expect(saved?.fetchedAt).toBe(at);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an empty selectable account-catalog list is efforts none only in the operator view', async () => {
    const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          {
            id: 'gpt-6.1-sol',
            output_modalities: ['text'],
            capabilities: { reasoning_effort: ['off'] },
          },
        ],
      },
    });
    const row = applied.models[0];
    if (!row) throw new Error('missing chatgpt row');
    expect(row.metadata.source).toBe(SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE);
    expect(row.efforts).toEqual(['off']);
    expect(selectableSubscriptionEfforts(row)).toEqual([]);
    const catalog = subscriptionAccountModelCatalog(applied);
    const viewed = withSelectableSubscriptionEfforts(catalog);
    expect(viewed).not.toBe(catalog);
    expect(viewed.models[0]?.efforts).toEqual([]);
    expect(modelDetails(viewed.models[0] as ModelRecord)).toContain('efforts:none');
    expect(modelDetails({ ...row, efforts: undefined })).toContain('efforts:unknown');
    expect(row.efforts).toEqual(['off']);
    const route = getRoute('chatgpt-subscription');
    expect(omittedEffort(route, { model: row.id, modelMetadata: row })).toBe('effort_unsupported');

    const home = mkdtempSync(join(tmpdir(), 'sov-sub-empty-efforts-'));
    try {
      const cache = diskModelCache(join(home, 'model-catalog'));
      const source = createSubscriptionModelSource('chatgpt-subscription');
      await cache.set(`${source.routeId}:${source.cacheKey}`, catalog);
      const stored = await cache.get(`${source.routeId}:${source.cacheKey}`);
      expect(stored?.models[0]?.efforts).toEqual(['off']);
      const snapshot = readModelCatalogSnapshot('chatgpt-subscription', {}, home);
      const shown = snapshot.models.find((model) => model.id === 'gpt-6.1-sol');
      expect(shown?.efforts).toEqual([]);
      expect(shown ? modelDetails(shown) : '').toContain('efforts:none');
      expect((await cache.get(`${source.routeId}:${source.cacheKey}`))?.models[0]?.efforts).toEqual(
        ['off'],
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a grok payload level absent from SUBSCRIPTION_ROUTE_EFFORTS.grok is not selectable', () => {
    expect(SUBSCRIPTION_ROUTE_EFFORTS.grok).toEqual(['low', 'medium', 'high', 'max']);
    const row = normalizeSubscriptionCatalogRow(
      {
        id: 'grok-4.7',
        output_modalities: ['text'],
        capabilities: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'] },
      },
      'grok-subscription',
      { accountCatalog: true, listedAt: listedAt() },
    );
    if (!row?.efforts) throw new Error('missing grok efforts');
    const selectable = selectableSubscriptionEfforts(row);
    expect(selectable).toEqual(['low', 'medium', 'high', 'max']);
    expect(selectable).not.toContain('off');
    for (const level of row.efforts) {
      if (!SUBSCRIPTION_ROUTE_EFFORTS.grok.includes(level)) expect(selectable).not.toContain(level);
    }
    const highOnly: ModelRecord = { ...row, efforts: ['high'] };
    expect(selectableSubscriptionEfforts(highOnly)).toEqual(['high']);
    const stale: ModelRecord = { ...row, metadata: { ...row.metadata, stale: true } };
    expect(selectableSubscriptionEfforts(stale)).toEqual(['low', 'medium', 'high', 'max']);
    expect(selectableSubscriptionEfforts(stale)).not.toContain('off');
    const bundled: ModelRecord = {
      ...row,
      metadata: { source: 'bundled-suggestions', stale: false },
    };
    expect(selectableSubscriptionEfforts(bundled)).toEqual(['low', 'medium', 'high', 'max']);
    expect(selectableSubscriptionEfforts(bundled)).toContain('max');
  });

  test('stale subscription rows do not keep expanded tools, effort, or context', () => {
    const applied = applySubscriptionAccountCatalog('grok-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          {
            id: 'grok-4.7',
            output_modalities: ['text'],
            context_length: 10,
            capabilities: { tools: true, reasoning_effort: ['low'] },
          },
        ],
      },
    });
    const aged = presentSubscriptionCatalog({
      version: 1,
      routeId: 'grok-subscription',
      state: 'stale',
      fetchedAt: listedAt(),
      models: applied.models.map((model) => ({
        ...model,
        metadata: { ...model.metadata, stale: true },
      })),
    });
    expect(aged.models[0]?.capabilities.tools).toBe('unknown');
    expect(aged.models[0]?.contextWindow).toBeUndefined();
    expect(aged.models[0]?.efforts).toBeUndefined();
    expect(aged.models[0]?.metadata.source).toBe(SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE);
    expect(selectableSubscriptionEfforts(aged.models[0] as ModelRecord)).toEqual([]);
  });

  test('a stale chatgpt pin does not regain cleared efforts', () => {
    const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          {
            id: 'gpt-5.3-codex',
            output_modalities: ['text'],
            capabilities: { reasoning_effort: ['high'] },
          },
        ],
      },
    });
    const row = applied.models.find((model) => model.id === 'gpt-5.3-codex');
    if (!row) throw new Error('missing pin');
    expect(selectableSubscriptionEfforts(row)).toEqual(['high']);
    const route = getRoute('chatgpt-subscription');
    expect(
      validateRouteSelection(route, { model: row.id, effort: 'high', modelMetadata: row }).effort,
    ).toBe('high');
    expect(() =>
      validateRouteSelection(route, { model: row.id, effort: 'medium', modelMetadata: row }),
    ).toThrow(/effort_unsupported|not supported/);
    expect(() =>
      validateRouteSelection(route, { model: row.id, effort: 'max', modelMetadata: row }),
    ).toThrow(/effort_unsupported|not supported/);

    const aged = presentSubscriptionCatalog({
      version: 1,
      routeId: 'chatgpt-subscription',
      state: 'stale',
      fetchedAt: listedAt(),
      models: [row],
    });
    const stale = aged.models[0];
    if (!stale) throw new Error('missing stale pin');
    expect(stale.metadata.stale).toBe(true);
    expect(stale.efforts).toBeUndefined();
    expect(selectableSubscriptionEfforts(stale)).toEqual([]);
    expect(() =>
      validateRouteSelection(route, { model: stale.id, effort: 'medium', modelMetadata: stale }),
    ).toThrow(/effort_unsupported|not supported/);
    expect(() =>
      validateRouteSelection(route, { model: stale.id, effort: 'max', modelMetadata: stale }),
    ).toThrow(/effort_unsupported|not supported/);

    const bare = applySubscriptionAccountCatalog('chatgpt-subscription', {
      listedAt: listedAt(),
      body: { models: [{ id: 'gpt-5.3-codex', output_modalities: ['text'] }] },
    }).models[0];
    if (!bare) throw new Error('missing bare pin');
    expect(bare.metadata.stale).toBe(false);
    expect(bare.efforts).toBeUndefined();
    expect(selectableSubscriptionEfforts(bare)).toEqual(['low', 'medium', 'high', 'max']);
  });
});

describe('subscription catalog disk isolation', () => {
  test('a current account catalog still names a missing or retired pin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-sub-pin-'));
    try {
      const root = join(home, 'model-catalog');
      const cache = diskModelCache(root);
      const source = createSubscriptionModelSource('grok-subscription');
      const key = `${source.routeId}:${source.cacheKey}`;
      const missing = applySubscriptionAccountCatalog('grok-subscription', {
        status: 200,
        listedAt: listedAt(),
        body: { models: [{ id: 'grok-account', output_modalities: ['text'] }] },
      });
      expect(missing.defaultModel).toBe('grok-4.7');
      expect(missing.missingPinnedDefault).toBe(true);
      await cache.set(key, diskShape('grok-subscription', missing.models, missing.listedAt));
      const missingSnapshot = readModelCatalogSnapshot('grok-subscription', {}, home);
      const missingPage = modelPage(missingSnapshot, { route: 'grok-subscription' });
      expect(JSON.stringify(missingPage)).toContain('grok-4.7');
      expect(JSON.stringify(missingPage).toLowerCase()).toContain('missing');
      expect(JSON.stringify(missingPage).toLowerCase()).toContain('default');
      expect(missingPage).toHaveProperty('error');
      expect(JSON.stringify(missingSnapshot)).toContain('grok-4.7');
      expect(JSON.stringify(missingSnapshot).toLowerCase()).toContain('missing');
      expect(missingSnapshot.models.map((model) => model.id)).toEqual(['grok-account']);
      expect(SUBSCRIPTION_DEFAULT_MODEL.grok).toBe('grok-4.7');

      const retired = applySubscriptionAccountCatalog('grok-subscription', {
        status: 200,
        listedAt: listedAt(),
        body: {
          models: [
            { id: 'grok-4.7', lifecycle: 'retired', output_modalities: ['text'] },
            { id: 'grok-4.6', output_modalities: ['text'] },
          ],
        },
      });
      expect(retired.defaultModel).toBe('grok-4.7');
      expect(retired.pinnedDefaultUnavailable).toBe(true);
      expect(retired.models.map((model) => model.id)).toEqual(['grok-4.6']);
      const retiredStored = subscriptionAccountModelCatalog(retired);
      expect(retiredStored.pinnedDefault).toEqual({ id: 'grok-4.7', status: 'unavailable' });
      expect(retiredStored.models.map((model) => model.id)).toEqual(['grok-4.6']);
      await cache.set(key, retiredStored);
      const retiredSnapshot = readModelCatalogSnapshot('grok-subscription', {}, home);
      const retiredPage = modelPage(retiredSnapshot, { route: 'grok-subscription' });
      const retiredText = JSON.stringify({ retiredSnapshot, retiredPage });
      expect(retiredText).toContain('grok-4.7');
      expect(retiredText.toLowerCase()).toContain('unavailable');
      expect(retiredText).toContain('"defaultModel":"grok-4.7"');
      expect(retiredPage).toHaveProperty('error');
      expect((retiredPage as { defaultModel?: string }).defaultModel).toBe('grok-4.7');
      expect(retiredSnapshot.models.map((model) => model.id)).not.toContain('grok-4.7');
      expect(SUBSCRIPTION_DEFAULT_MODEL.grok).toBe('grok-4.7');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a failed refresh does not leave the current account catalog on disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-sub-fail-'));
    try {
      const root = join(home, 'model-catalog');
      const cache = diskModelCache(root);
      const source = createSubscriptionModelSource('chatgpt-subscription');
      const key = `${source.routeId}:${source.cacheKey}`;
      const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
        status: 200,
        listedAt: listedAt(),
        body: {
          models: [
            {
              id: 'gpt-5.3-codex',
              output_modalities: ['text'],
              context_window: 8192,
              capabilities: { tools: true, reasoning_effort: ['high'] },
            },
          ],
        },
      });
      const row = applied.models[0];
      if (!row) throw new Error('missing row');
      expect(row.capabilities.tools).toBe('supported');
      expect(row.availability).toBe('account');
      await cache.set(key, diskShape('chatgpt-subscription', applied.models, applied.listedAt));
      await createModelDiscovery({ cache }).refresh(source);
      const saved = await diskModelCache(root).get(key);
      expect(saved).toBeDefined();
      if (!saved) return;
      expect(saved.state).not.toBe('current');
      const kept = saved.models.find((model) => model.id === row.id);
      expect(kept?.availability).not.toBe('account');
      expect(kept?.capabilities.tools).not.toBe('supported');
      expect(kept?.contextWindow).toBeUndefined();
      expect(kept?.efforts?.some((level) => level !== 'off')).not.toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a refresh does not restore an account catalog deleted before the failed write', async () => {
    const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          { id: 'gpt-account-a', output_modalities: ['text'], capabilities: { tools: true } },
        ],
      },
    });
    const original = subscriptionAccountModelCatalog(applied);
    expect(original.models[0]?.id).toBe('gpt-account-a');
    let remaining: ModelCatalog | undefined = original;
    let writes = 0;
    const cache = {
      async get() {
        const value = remaining;
        remaining = undefined;
        return value ? structuredClone(value) : undefined;
      },
      async set(_key: string, value: ModelCatalog) {
        writes += 1;
        remaining = structuredClone(value);
      },
    };
    const source = createSubscriptionModelSource('chatgpt-subscription');
    await createModelDiscovery({ cache }).refresh(source);
    expect(writes).toBe(0);
    expect(remaining).toBeUndefined();
    expect(JSON.stringify(remaining ?? {})).not.toContain('gpt-account-a');
  });

  test('a failed refresh does not restore a grok catalog removed before rename', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-sub-refresh-race-'));
    try {
      const root = join(home, 'model-catalog');
      const disk = diskModelCache(root);
      const source = createSubscriptionModelSource('grok-subscription');
      const key = `${source.routeId}:${source.cacheKey}`;
      const applied = applySubscriptionAccountCatalog('grok-subscription', {
        listedAt: listedAt(),
        body: {
          models: [
            {
              id: 'grok-account-a',
              output_modalities: ['text'],
              capabilities: { tools: true },
            },
          ],
        },
      });
      const stored = subscriptionAccountModelCatalog(applied);
      expect(stored.state).toBe('current');
      expect(stored.models.some((model) => model.id === 'grok-account-a')).toBe(true);
      await disk.set(key, stored);

      let gets = 0;
      const cache = {
        async get(cacheKey: string) {
          const value = await disk.get(cacheKey);
          gets += 1;
          return value;
        },
        async set(cacheKey: string, value: ModelCatalog, expected?: ModelCatalog) {
          // After the re-read returns the stored catalog, login can rmSync the
          // route directory before diskModelCache renameSync.
          if (gets >= 2) clearSubscriptionCatalogCache(root, 'grok-subscription');
          await disk.set(cacheKey, value, expected);
        },
      };

      await createModelDiscovery({ cache }).refresh(source);
      const later = await disk.get(key);
      expect(JSON.stringify(later ?? {})).not.toContain('grok-account-a');
      const routeDir = join(root, 'subscription', 'grok-subscription');
      try {
        for (const name of readdirSync(routeDir)) {
          if (!name.endsWith('.json')) continue;
          expect(readFileSync(join(routeDir, name), 'utf8')).not.toContain('grok-account-a');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const reread = await createModelDiscovery({ cache: disk }).read(source);
      expect(
        reread.models.some(
          (model) => model.metadata.source === SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE,
        ),
      ).toBe(false);
      expect(reread.models.some((model) => model.id === 'grok-account-a')).toBe(false);
      expect(
        reread.models.some(
          (model) =>
            model.id === 'grok-4.7' && model.metadata.source === GROK_SUBSCRIPTION_PIN_SOURCE,
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a failed refresh does not treat equal fetchedAt and ids as the same entry', async () => {
    const applied = applySubscriptionAccountCatalog('grok-subscription', {
      listedAt: listedAt(),
      body: {
        models: [{ id: 'grok-4.7', output_modalities: ['text'], capabilities: { tools: true } }],
      },
    });
    const original = subscriptionAccountModelCatalog(applied);
    const replacement: ModelCatalog = {
      ...structuredClone(original),
      models: original.models.map((model) => ({ ...model, displayName: 'replaced-account' })),
    };
    expect(original.fetchedAt).toBe(replacement.fetchedAt);
    expect(original.models.map((model) => model.id).join('\0')).toBe(
      replacement.models.map((model) => model.id).join('\0'),
    );
    let reads = 0;
    let stored: ModelCatalog | undefined = original;
    const cache = {
      async get() {
        reads += 1;
        if (reads === 2) stored = structuredClone(replacement);
        return stored ? structuredClone(stored) : undefined;
      },
      async set(_key: string, value: ModelCatalog) {
        stored = structuredClone(value);
      },
    };
    await createModelDiscovery({ cache }).refresh(
      createSubscriptionModelSource('grok-subscription'),
    );
    expect(stored?.state).toBe('current');
    expect(stored?.models[0]?.displayName).toBe('replaced-account');
    expect(stored?.models.some((model) => model.id === 'grok-4.7')).toBe(true);
  });

  test('accounts, owners, logout, and API caches stay apart', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'sov-sub-a-'));
    const homeB = mkdtempSync(join(tmpdir(), 'sov-sub-b-'));
    try {
      const rootA = join(homeA, 'model-catalog');
      const cacheA = diskModelCache(rootA);
      const cacheB = diskModelCache(join(homeB, 'model-catalog'));
      const source = modelSource('grok-subscription');
      expect(source.cacheKey).toBe('SOV_SUB_GROK:SOV_SUB_GROK');
      const keyA = `${source.routeId}:${source.cacheKey}`;
      const other = createSubscriptionModelSource('grok-subscription', 'acct-b');
      const keyB = `${other.routeId}:${other.cacheKey}`;
      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toContain('public');
      let fetches = 0;
      const refreshed = await createModelDiscovery({
        cache: cacheA,
        fetch: (async () => {
          fetches += 1;
          throw new Error('must not fetch');
        }) as unknown as typeof globalThis.fetch,
      }).refresh(source);
      expect(fetches).toBe(0);
      expect(refreshed.state).not.toBe('current');
      expect(refreshed.models.some((model) => model.id === 'grok-4.7')).toBe(true);
      expect(refreshed.models.some((model) => model.id === 'grok-4.6')).toBe(true);
      expect(fallbackModelCatalog('grok-subscription').models.map((model) => model.id)).toEqual([
        'grok-4.7',
        'grok-4.6',
      ]);
      const negative = await readModelCatalog('grok-subscription', {}, true, cacheA);
      expect(negative.state).not.toBe('current');
      const negativePins = negative.models.filter(
        (model) => model.metadata.source === GROK_SUBSCRIPTION_PIN_SOURCE,
      );
      const negativeAccounts = negative.models.filter(
        (model) => model.metadata.source === SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE,
      );
      expect(negativePins.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6']);
      expect(negativePins.find((model) => model.id === 'grok-4.7')?.contextWindow).toBe(500_000);
      expect(negativePins.find((model) => model.id === 'grok-4.6')?.contextWindow).toBe(500_000);
      expect(negativePins.every((model) => model.capabilities.tools === 'supported')).toBe(true);
      expect(negativeAccounts.every((model) => model.capabilities.tools !== 'supported')).toBe(
        true,
      );
      expect(negativeAccounts.every((model) => model.contextWindow === undefined)).toBe(true);
      const negativeFiles = readdirSync(join(rootA, 'subscription', 'grok-subscription'));
      for (const name of negativeFiles) {
        const text = readFileSync(join(rootA, 'subscription', 'grok-subscription', name), 'utf8');
        expect(JSON.parse(text).state).not.toBe('current');
        expect(TOKEN_MATERIAL.test(text)).toBe(false);
      }
      const applied = applySubscriptionAccountCatalog('grok-subscription', {
        listedAt: listedAt(),
        body: {
          models: [
            {
              id: 'grok-4.7',
              display_name: 'Bearer sk-secret',
              access_token: 'access_token no',
              refresh_token: 'refresh_token no',
              output_modalities: ['text'],
              capabilities: { tools: true },
              context_window: 4096,
            },
          ],
        },
      });
      expect(TOKEN_MATERIAL.test(JSON.stringify(applied))).toBe(false);
      expect(applied.models[0]?.displayName).toBe('grok-4.7');
      const snapshot = diskShape('grok-subscription', applied.models, applied.listedAt);
      await cacheA.set(keyA, snapshot);
      expect(await cacheA.get(keyB)).toBeUndefined();
      expect(await cacheB.get(keyA)).toBeUndefined();
      expect((await cacheA.get(keyA))?.models[0]?.id).toBe('grok-4.7');
      const seenA = readModelCatalogSnapshot('grok-subscription', {}, homeA);
      expect(seenA.models.some((model) => model.id === 'grok-4.7')).toBe(true);
      const seenB = readModelCatalogSnapshot('grok-subscription', {}, homeB);
      expect(seenB.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6']);
      expect(
        seenB.models.every((model) => model.metadata.source === GROK_SUBSCRIPTION_PIN_SOURCE),
      ).toBe(true);
      expect(
        seenB.models.some((model) => model.metadata.source === SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE),
      ).toBe(false);

      const apiCatalog = fallbackModelCatalog('openai-api');
      apiCatalog.state = 'current';
      apiCatalog.fetchedAt = listedAt();
      const first = apiCatalog.models[0];
      if (!first) throw new Error('missing api fixture');
      first.contextWindow = 12345;
      await cacheA.set('openai-api:deadbeef', apiCatalog);
      await cacheA.set('openai-api:ambiguous-account-pool', apiCatalog);
      await cacheA.set('openai-api:unconfigured', apiCatalog);
      const chatSnapshot = diskShape(
        'chatgpt-subscription',
        applySubscriptionAccountCatalog('chatgpt-subscription', {
          listedAt: listedAt(),
          body: {
            models: [
              { id: 'gpt-5.3-codex', output_modalities: ['text'], capabilities: { tools: true } },
            ],
          },
        }).models,
      );
      await cacheA.set('chatgpt-subscription:SOV_SUB_CHATGPT:SOV_SUB_CHATGPT', chatSnapshot);

      const files = readdirSync(join(rootA, 'subscription', 'grok-subscription'));
      expect(files.length).toBeGreaterThan(0);
      for (const name of files) {
        const file = join(rootA, 'subscription', 'grok-subscription', name);
        const text = readFileSync(file, 'utf8');
        expect(TOKEN_MATERIAL.test(text)).toBe(false);
        expect(file).not.toContain(`${join('packages', 'sdk')}`);
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      expect(statSync(join(rootA, 'subscription')).mode & 0o777).toBe(0o700);
      expect(statSync(rootA).mode & 0o777).toBe(0o700);

      const poisoned: ModelCatalog = {
        ...snapshot,
        models: [{ ...snapshot.models[0], displayName: 'Bearer sk-secret' } as ModelRecord],
      };
      await expect(cacheA.set(keyA, poisoned)).rejects.toThrow(/credential/i);
      expect(
        TOKEN_MATERIAL.test(
          readFileSync(
            join(rootA, 'subscription', 'grok-subscription', files[0] as string),
            'utf8',
          ),
        ),
      ).toBe(false);
      await expect(
        cacheA.set('grok-subscription:public', fallbackModelCatalog('grok-subscription')),
      ).rejects.toThrow(/account identity/i);
      expect(await cacheA.get('grok-subscription:public')).toBeUndefined();

      const hooks = subscriptionSessionHooks(homeA);
      let seen: unknown;
      expect(
        await logoutSubscription('chatgpt', memoryPort(), silentIo, {
          onIdentityChanged: (name) => {
            seen = name;
            hooks.onIdentityChanged(name);
          },
        }),
      ).toBe(0);
      expect(seen).toBe('chatgpt');
      expect(
        await cacheA.get('chatgpt-subscription:SOV_SUB_CHATGPT:SOV_SUB_CHATGPT'),
      ).toBeUndefined();
      expect((await cacheA.get(keyA))?.models[0]?.id).toBe('grok-4.7');
      expect((await cacheA.get('openai-api:deadbeef'))?.models[0]?.contextWindow).toBe(12345);
      expect(await cacheA.get('openai-api:ambiguous-account-pool')).toBeDefined();
      expect(await cacheA.get('openai-api:unconfigured')).toBeDefined();

      seen = undefined;
      expect(
        await logoutSubscription('grok', memoryPort(), silentIo, {
          onIdentityChanged: (name) => {
            seen = name;
            return hooks.onIdentityChanged(name);
          },
        }),
      ).toBe(0);
      expect(seen).toBe('grok');
      expect(await cacheA.get(keyA)).toBeUndefined();
      expect(await cacheA.get(keyB)).toBeUndefined();
      expect((await cacheA.get('openai-api:deadbeef'))?.models[0]?.contextWindow).toBe(12345);

      await cacheA.set(keyA, snapshot);
      await cacheA.set(keyB, {
        ...snapshot,
        models: [
          { ...snapshot.models[0], id: 'grok-other', displayName: 'grok-other' } as ModelRecord,
        ],
      });
      expect((await cacheA.get(keyA))?.models[0]?.id).not.toBe(
        (await cacheA.get(keyB))?.models[0]?.id,
      );
      hooks.onIdentityChanged('grok');
      expect(await cacheA.get(keyA)).toBeUndefined();
      expect(await cacheA.get(keyB)).toBeUndefined();
      expect((await cacheA.get('openai-api:ambiguous-account-pool'))?.state).toBe('current');

      await cacheA.set(keyA, snapshot);
      expect(await logoutSubscription('claude-max', memoryPort(), silentIo, hooks)).toBe(0);
      expect((await cacheA.get(keyA))?.models[0]?.id).toBe('grok-4.7');
    } finally {
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  test('a completed login clears that route catalog and does not receive the token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-sub-login-'));
    const secret = 'super-secret-access';
    try {
      const cache = diskModelCache(join(home, 'model-catalog'));
      const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
        listedAt: listedAt(),
        body: { models: [{ id: 'gpt-5.3-codex', output_modalities: ['text'] }] },
      });
      await cache.set(
        'chatgpt-subscription:SOV_SUB_CHATGPT:SOV_SUB_CHATGPT',
        diskShape('chatgpt-subscription', applied.models, applied.listedAt),
      );
      const grok = applySubscriptionAccountCatalog('grok-subscription', {
        listedAt: listedAt(),
        body: { models: [{ id: 'grok-4.6', output_modalities: ['text'] }] },
      });
      await cache.set(
        'grok-subscription:SOV_SUB_GROK:SOV_SUB_GROK',
        diskShape('grok-subscription', grok.models, grok.listedAt),
      );
      let step = 0;
      let hookArgs = '';
      const code = await loginSubscription(
        'chatgpt',
        memoryPort(),
        {
          ...silentIo,
          fetchImpl: async () => {
            step += 1;
            if (step === 1) {
              return Response.json({ user_code: 'ABCD-EFGH', device_auth_id: 'dev1', interval: 1 });
            }
            if (step === 2) return new Response('pending', { status: 404 });
            if (step === 3) {
              return Response.json({ authorization_code: 'code1', code_verifier: 'ver1' });
            }
            return Response.json({
              access_token: secret,
              refresh_token: 'refresh-token',
              expires_in: 3600,
            });
          },
        },
        {
          onIdentityChanged: (name) => {
            hookArgs = JSON.stringify(name);
            subscriptionSessionHooks(home).onIdentityChanged(name);
          },
        },
      );
      expect(code).toBe(0);
      expect(hookArgs).toBe('"chatgpt"');
      expect(hookArgs).not.toContain(secret);
      expect(
        await cache.get('chatgpt-subscription:SOV_SUB_CHATGPT:SOV_SUB_CHATGPT'),
      ).toBeUndefined();
      expect(await cache.get('grok-subscription:SOV_SUB_GROK:SOV_SUB_GROK')).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a chatgpt pin that published only off stays empty when projected again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-sub-pin-off-'));
    try {
      const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
        listedAt: listedAt(),
        body: {
          models: [
            {
              id: 'gpt-5.3-codex',
              output_modalities: ['text'],
              capabilities: { reasoning_effort: ['off'] },
            },
          ],
        },
      });
      const catalog = subscriptionAccountModelCatalog(applied);
      const stored = catalog.models.find((model) => model.id === 'gpt-5.3-codex');
      if (!stored) throw new Error('missing pin');
      expect(stored.efforts).toEqual(['off']);
      expect(selectableSubscriptionEfforts(stored)).toEqual([]);

      const cache = diskModelCache(join(home, 'model-catalog'));
      const source = createSubscriptionModelSource('chatgpt-subscription');
      const key = `${source.routeId}:${source.cacheKey}`;
      await cache.set(key, catalog);
      const snapshot = readModelCatalogSnapshot('chatgpt-subscription', {}, home);
      const pin = snapshot.models.find((model) => model.id === 'gpt-5.3-codex');
      if (!pin) throw new Error('missing snapshot pin');
      expect(pin.efforts).toEqual([]);
      expect(modelDetails(pin)).toContain('efforts:none');
      const route = getRoute('chatgpt-subscription');
      let rejected: unknown;
      try {
        validateRouteSelection(route, { model: pin.id, modelMetadata: pin });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(RouteError);
      if (!(rejected instanceof RouteError)) throw new Error('expected RouteError');
      expect(rejected.code).toBe('effort_unsupported');
      expect(rejected.message).toBe(
        'this model has no subscription effort this transport can send',
      );
      for (const effort of ['high', 'max'] as const) {
        expect(() =>
          validateRouteSelection(route, { model: pin.id, effort, modelMetadata: pin }),
        ).toThrow(/not supported/);
      }
      const again = withSelectableSubscriptionEfforts(snapshot);
      expect(again.models.find((model) => model.id === 'gpt-5.3-codex')?.efforts).toEqual([]);
      expect(selectableSubscriptionEfforts(pin)).toEqual([]);
      expect((await cache.get(key))?.models[0]?.efforts).toEqual(['off']);

      const omitted = applySubscriptionAccountCatalog('chatgpt-subscription', {
        listedAt: listedAt(),
        body: { models: [{ id: 'gpt-5.3-codex', output_modalities: ['text'] }] },
      });
      const bare = omitted.models[0];
      if (!bare) throw new Error('missing omitted pin');
      expect(bare.efforts).toBeUndefined();
      expect(modelDetails(bare)).toContain('efforts:unknown');
      expect(selectableSubscriptionEfforts(bare)).toEqual(['low', 'medium', 'high', 'max']);
      await cache.set(key, subscriptionAccountModelCatalog(omitted));
      const omittedSnapshot = readModelCatalogSnapshot('chatgpt-subscription', {}, home);
      const omittedPin = omittedSnapshot.models.find((model) => model.id === 'gpt-5.3-codex');
      if (!omittedPin) throw new Error('missing omitted snapshot pin');
      expect(omittedPin.efforts).toBeUndefined();
      expect(modelDetails(omittedPin)).toContain('efforts:unknown');
      expect(selectableSubscriptionEfforts(omittedPin)).toEqual(['low', 'medium', 'high', 'max']);
      expect(
        validateRouteSelection(route, { model: omittedPin.id, modelMetadata: omittedPin }).effort,
      ).toBe(route.defaultEffort);
      expect(
        selectableSubscriptionEfforts(
          withSelectableSubscriptionEfforts(omittedSnapshot).models[0] as ModelRecord,
        ),
      ).toEqual(['low', 'medium', 'high', 'max']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a rejected listedAt is not cacheable and small skew still reads back as current', async () => {
    const body = {
      models: [
        {
          id: 'gpt-5.3-codex',
          output_modalities: ['text'],
          context_window: 8192,
          capabilities: { tools: true, reasoning_effort: ['high'] },
        },
      ],
    };
    for (const listedAt of [
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      'not-a-timestamp',
    ]) {
      const rejected = applySubscriptionAccountCatalog('chatgpt-subscription', {
        status: 200,
        listedAt,
        body,
      });
      expect(rejected.cacheableCurrent).toBe(false);
      expect(rejected.state).not.toBe('current');
    }

    const home = mkdtempSync(join(tmpdir(), 'sov-sub-listed-at-'));
    try {
      const cache = diskModelCache(join(home, 'model-catalog'));
      const source = createSubscriptionModelSource('chatgpt-subscription');
      const key = `${source.routeId}:${source.cacheKey}`;
      const readBack = async (at: string) => {
        const applied = applySubscriptionAccountCatalog('chatgpt-subscription', {
          status: 200,
          listedAt: at,
          body,
        });
        expect(applied.state).toBe('current');
        expect(applied.cacheableCurrent).toBe(true);
        const catalog = subscriptionAccountModelCatalog(applied);
        expect(catalog.state).toBe('current');
        expect(catalog.fetchedAt).toBeDefined();
        const fetchedAt = Date.parse(catalog.fetchedAt ?? '');
        expect(Number.isFinite(fetchedAt)).toBe(true);
        expect(fetchedAt).toBeLessThanOrEqual(Date.now());
        await cache.set(key, catalog);
        return readModelCatalogSnapshot('chatgpt-subscription', {}, home);
      };

      for (const at of [
        new Date(Date.now()).toISOString(),
        new Date(Date.now() + 5_000).toISOString(),
        new Date(Date.now() + 3 * 60 * 1000).toISOString(),
      ]) {
        const snapshot = await readBack(at);
        const row = snapshot.models.find((model) => model.id === 'gpt-5.3-codex');
        expect(snapshot.state).toBe('current');
        expect(row?.capabilities.tools).toBe('supported');
        expect(row?.efforts).toContain('high');
        expect(row?.contextWindow).toBe(8192);
        expect(row?.availability).toBe('account');
        expect(row?.metadata.stale).toBe(false);
      }

      const expired = await readBack(new Date(Date.now() - 3_600_000 - 1_000).toISOString());
      const aged = expired.models.find((model) => model.id === 'gpt-5.3-codex');
      expect(expired.state).not.toBe('current');
      expect(aged?.capabilities.tools).not.toBe('supported');
      expect(aged?.efforts?.includes('high')).not.toBe(true);
      expect(aged?.contextWindow).toBeUndefined();
      expect(aged?.availability).not.toBe('account');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a non-current grok catalog keeps the publisher pin and rejects an expanded account row', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-sub-pin-guard-'));
    try {
      const root = join(home, 'model-catalog');
      const cache = diskModelCache(root);
      const source = createSubscriptionModelSource('grok-subscription');
      const key = `${source.routeId}:${source.cacheKey}`;
      const pin = grokSubscriptionPin('grok-4.7');
      await cache.set(key, {
        version: 1,
        routeId: 'grok-subscription',
        state: 'unavailable',
        models: [pin],
      });
      const stored = await cache.get(key);
      expect(stored?.models.map((model) => model.id)).toEqual(['grok-4.7']);
      expect(stored?.models[0]?.capabilities.tools).toBe('supported');
      expect(stored?.models[0]?.contextWindow).toBe(500_000);
      const account = applySubscriptionAccountCatalog('grok-subscription', {
        listedAt: listedAt(),
        body: {
          models: [
            { id: 'grok-account', output_modalities: ['text'], capabilities: { tools: true } },
          ],
        },
      }).models[0];
      if (!account) throw new Error('missing account row');
      await expect(
        cache.set(key, {
          version: 1,
          routeId: 'grok-subscription',
          state: 'unavailable',
          models: [{ ...account, metadata: { ...account.metadata, stale: true } }],
        }),
      ).rejects.toThrow('Negative subscription cache cannot expand capabilities');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('a live text row keeps the subscription pin available beside a dropped duplicate', () => {
  const text = {
    id: 'grok-4.7',
    output_modalities: ['text'],
    capabilities: { tools: true },
  };
  const retired = { id: 'grok-4.7', lifecycle: 'retired', output_modalities: ['text'] };
  const video = { id: 'grok-4.7', output_modalities: ['video'] };
  for (const models of [
    [text, retired],
    [retired, text],
    [text, video],
    [video, text],
  ]) {
    const applied = applySubscriptionAccountCatalog('grok-subscription', { body: { models } });
    expect(applied.state).toBe('current');
    expect(applied.pinnedDefaultUnavailable).toBe(false);
    expect(applied.models.map((model) => model.id)).toEqual(['grok-4.7']);
    expect(applied.models[0]?.capabilities.tools).toBe('supported');
    const stored = subscriptionAccountModelCatalog(applied);
    expect(stored.pinnedDefault).toBeUndefined();
    expect(reportSubscriptionPin(stored)).toBeUndefined();
    expect(
      reportSubscriptionPin({
        ...stored,
        pinnedDefault: { id: 'grok-4.7', status: 'unavailable' },
      }),
    ).toBeUndefined();
  }

  const retiredOnly = applySubscriptionAccountCatalog('grok-subscription', {
    body: { models: [{ id: 'grok-4.7', lifecycle: 'retired', output_modalities: ['text'] }] },
  });
  expect(retiredOnly.state).toBe('unavailable');
  expect(retiredOnly.pinnedDefaultUnavailable).toBe(true);
  expect(retiredOnly.models.map((model) => model.id)).not.toContain('grok-4.7');
  expect(retiredOnly.models.map((model) => model.id)).toContain('grok-4.6');
  expect(reportSubscriptionPin(subscriptionAccountModelCatalog(retiredOnly))).toEqual({
    id: 'grok-4.7',
    status: 'unavailable',
  });
});
