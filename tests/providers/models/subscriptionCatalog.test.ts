import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSubscriptionModelSource,
  normalizeDirectModel,
} from '@yevgetman/sov-sdk/providers/models/direct';
import {
  createModelDiscovery,
  fallbackModelCatalog,
} from '@yevgetman/sov-sdk/providers/models/index';
import {
  SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE,
  applySubscriptionAccountCatalog,
  normalizeSubscriptionCatalogRow,
  presentSubscriptionCatalog,
  selectableSubscriptionEfforts,
  subscriptionToolsSelectable,
} from '@yevgetman/sov-sdk/providers/models/subscriptionCatalog';
import type { ModelCatalog, ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
import { validateModelRequest } from '@yevgetman/sov-sdk/providers/models/validateRequest';
import { getRoute, validateRouteSelection } from '@yevgetman/sov-sdk/providers/routes/index';
import {
  loginSubscription,
  logoutSubscription,
} from '@yevgetman/sov-sdk/providers/subscription/login';
import { SUBSCRIPTION_DEFAULT_MODEL } from '@yevgetman/sov-sdk/providers/subscription/names';
import type { SubscriptionCredentialPort } from '@yevgetman/sov-sdk/providers/subscription/port';
import {
  diskModelCache,
  modelSource,
  readModelCatalog,
  readModelCatalogSnapshot,
  subscriptionSessionHooks,
} from '../../../src/cli/modelDiscovery.js';

const TOKEN_MATERIAL = /authorization|bearer|\bsk-|access_token|refresh_token/i;
const listedAt = () => new Date(Date.now() - 60_000).toISOString();

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
      expect(catalog.models.every((model) => model.metadata.source === 'bundled-suggestions')).toBe(
        true,
      );
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
      expect(applied.defaultModel).toBe('grok-4.6');
      expect(applied.models.map((model) => model.id)).toEqual(['grok-4.6']);
      expect(applied.models.every((model) => model.auth === 'subscription')).toBe(true);
      expect(applied.models.every((model) => model.metadata.source === 'bundled-suggestions')).toBe(
        true,
      );
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

  test('retired and non-text rows drop and a retired pin is not replaced', () => {
    const applied = applySubscriptionAccountCatalog('grok-subscription', {
      listedAt: listedAt(),
      body: {
        models: [
          { id: 'grok-4.6', lifecycle: 'retired', output_modalities: ['text'] },
          { id: 'grok-video', output_modalities: ['video'], capabilities: { tools: true } },
          {
            id: 'grok-4.7',
            output_modalities: ['text'],
            capabilities: { tools: true },
            max_input_tokens: 128_000,
          },
        ],
      },
    });
    expect(applied.state).toBe('current');
    expect(applied.models.map((model) => model.id)).toEqual(['grok-4.7']);
    expect(applied.defaultModel).toBe('grok-4.6');
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
    expect(grok.missingPinnedDefault).toBe(true);
    expect(grok.defaultModel).toBe(SUBSCRIPTION_DEFAULT_MODEL.grok);
    expect(row.efforts).toEqual(['off', 'low', 'high', 'max']);
    expect(row.capabilities.images).toBe('supported');
    expect(selectableSubscriptionEfforts(row)).toEqual(['off']);
    const route = getRoute('grok-subscription');
    expect(validateRouteSelection(route, { model: 'grok-4.7', modelMetadata: row }).effort).toBe(
      'off',
    );
    expect(() =>
      validateRouteSelection(route, { model: 'grok-4.7', effort: 'high', modelMetadata: row }),
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
    expect(getRoute('grok-subscription').modelsAuthoritative).toBe(false);
    expect(getRoute('chatgpt-subscription').modelsAuthoritative).toBe(false);
    expect(getRoute('grok-subscription').models).toEqual(['grok-4.6']);
    expect(getRoute('chatgpt-subscription').models).toEqual(['gpt-5.3-codex']);
    expect(SUBSCRIPTION_DEFAULT_MODEL).toEqual({ chatgpt: 'gpt-5.3-codex', grok: 'grok-4.6' });
    const settings = {
      routes: { 'grok-subscription': { defaultModel: 'grok-4.6' } },
      providers: { xai: { model: 'grok-4.6' }, openai: { model: 'gpt-5.3-codex' } },
    };
    expect(settings.routes['grok-subscription'].defaultModel).toBe('grok-4.6');
    expect(settings.providers.xai.model).toBe('grok-4.6');
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
    expect(selectableSubscriptionEfforts(aged.models[0] as ModelRecord)).toEqual(['off']);
  });
});

describe('subscription catalog disk isolation', () => {
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
      expect(refreshed.models.some((model) => model.id === 'grok-4.6')).toBe(true);
      expect(fallbackModelCatalog('grok-subscription').models.map((model) => model.id)).toEqual([
        'grok-4.6',
      ]);
      const negative = await readModelCatalog('grok-subscription', {}, true, cacheA);
      expect(negative.state).not.toBe('current');
      expect(negative.models.every((model) => model.capabilities.tools !== 'supported')).toBe(true);
      expect(negative.models.every((model) => model.contextWindow === undefined)).toBe(true);
      expect(negative.models.some((model) => model.id === 'grok-4.6')).toBe(true);
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
      expect(seenB.models.some((model) => model.id === 'grok-4.7')).toBe(false);
      expect(seenB.models.every((model) => model.metadata.source === 'bundled-suggestions')).toBe(
        true,
      );

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
});
