// Built-in auth routes: catalog invariants, validation, resolution and error
// codes. Fake keys, a fake Keychain port, temp homes; no network, no stream.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@yevgetman/sov-sdk/config/schema';
import {
  ClaudeMaxTermsError,
  ContextOverflowError,
  CredentialStoreUnavailableError,
  CredentialUnavailableError,
  PersistBeforeRunError,
  ProviderHttpError,
  SubscriptionAuthExpiredError,
  SubscriptionHttpError,
  SubscriptionLoginMissingError,
  SubscriptionRecordUnreadableError,
  SubscriptionTierBlockedError,
} from '@yevgetman/sov-sdk/providers/errors';
import {
  ROUTE_ERROR_CODES,
  ROUTE_IDS,
  RouteError,
  getRoute,
  imageRoutes,
  inspectRouteCredential,
  listRoutes,
  resolveRouteProvider,
  routeErrorCodeFor,
  routeSupportsImages,
  validateRouteSelection,
} from '@yevgetman/sov-sdk/providers/routes/index';
import type {
  SubscriptionCredentialPort,
  SubscriptionRecord,
} from '@yevgetman/sov-sdk/providers/subscription/port';

const NOW = 1_800_000_000_000;
const FAKE_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-FAKE000000000000000000000000',
  OPENAI_API_KEY: 'sk-FAKEOPENAI00000000000000000000',
  OPENROUTER_API_KEY: 'sk-or-FAKE0000000000000000000000',
  XAI_API_KEY: 'xai-FAKE00000000000000000000000000',
};

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'harness-routes-test-'));
}

function fakePort(
  record: SubscriptionRecord | null | Error,
): SubscriptionCredentialPort & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(service) {
      reads.push(service);
      if (record instanceof Error) throw record;
      return record ? { ...record } : null;
    },
    async write() {
      throw new Error('status/resolve must never write');
    },
    async delete() {
      throw new Error('status/resolve must never delete');
    },
  };
}

const LIVE: SubscriptionRecord = {
  accessToken: 'access-SECRET',
  refreshToken: 'refresh-SECRET',
  expiresAt: NOW + 3_600_000,
};

test('OpenAI route advertises reasoning choices without granting them to its non-reasoning default', () => {
  const route = getRoute('openai-api', {});
  expect(route.efforts).toContain('high');
  expect(route.modelEfforts['gpt-4o-mini']).toEqual(['off']);
  expect(route.modelEfforts['gpt-5']).toContain('high');
});

describe('route catalog', () => {
  test('six reserved routes with the exact provider/auth pairs', () => {
    const pairs = listRoutes().map((r) => [r.id, r.provider, r.auth]);
    expect(pairs).toEqual([
      ['openrouter-api', 'openrouter', 'api_key'],
      ['anthropic-api', 'anthropic', 'api_key'],
      ['openai-api', 'openai', 'api_key'],
      ['grok-api', 'xai', 'api_key'],
      ['chatgpt-subscription', 'chatgpt', 'subscription'],
      ['grok-subscription', 'grok', 'subscription'],
    ]);
    expect(ROUTE_IDS.length).toBe(6);
  });

  test('records satisfy the Telekit catalog invariants', () => {
    const settings = SettingsSchema.parse({
      thinking: { effort: 'high' },
      routes: { 'chatgpt-subscription': { defaultModel: 'gpt-5.9-codex' } },
      providers: { openrouter: { model: 'x-ai/grok-4' } },
    });
    for (const route of listRoutes(settings)) {
      expect(route.models).toContain(route.defaultModel);
      expect(route.efforts.length).toBeGreaterThan(0);
      if (route.id !== 'chatgpt-subscription') expect(route.efforts).toContain('off');
      for (const [model, efforts] of Object.entries(route.modelEfforts)) {
        expect(route.models).toContain(model);
        expect(efforts.length).toBeGreaterThan(0);
        for (const e of efforts) expect(route.efforts).toContain(e);
      }
      expect(route.modelEfforts[route.defaultModel]).toContain(route.defaultEffort);
      expect(route.enabled).toBe(true);
      expect(route.credentialRef).toBe(`${route.auth}:${route.provider}`);
    }
  });

  test('record JSON carries no credential material', () => {
    const json = JSON.stringify(
      listRoutes({ providers: { xai: { apiKey: FAKE_KEYS.XAI_API_KEY } } }),
    );
    expect(json).not.toContain(FAKE_KEYS.XAI_API_KEY);
  });

  test('default-model overrides: routes.<id> > providers.<p>.model > built-in', () => {
    const settings = SettingsSchema.parse({
      routes: { 'anthropic-api': { defaultModel: 'claude-sonnet-4-6' } },
      providers: { anthropic: { model: 'claude-opus-4-7' }, openai: { model: 'gpt-4o' } },
    });
    expect(getRoute('anthropic-api', settings).defaultModel).toBe('claude-sonnet-4-6');
    expect(getRoute('openai-api', settings).defaultModel).toBe('gpt-4o');
    expect(getRoute('grok-api', settings).defaultModel).toBe('grok-4.6');
    expect(getRoute('chatgpt-subscription').defaultModel).toBe('gpt-5.3-codex');
    expect(getRoute('grok-subscription').defaultModel).toBe('grok-4.6');
  });

  test('an incompatible explicit route or provider default is refused without fallback', () => {
    expect(() =>
      getRoute('grok-api', { routes: { 'grok-api': { defaultModel: 'x-ai/grok-4' } } }),
    ).toThrow('configured default model');
    expect(() =>
      getRoute('openai-api', { providers: { openai: { model: 'claude-opus-4-7' } } }),
    ).toThrow('configured default model');
    expect(() =>
      getRoute('openai-api', { routes: { 'openai-api': { defaultModel: '' } } }),
    ).toThrow('configured default model');
  });

  test('defaultEffort follows thinking.effort only when the default model supports it', () => {
    const settings = { thinking: { effort: 'high' as const } };
    expect(getRoute('anthropic-api', settings).defaultEffort).toBe('high');
    expect(getRoute('openai-api', settings).defaultEffort).toBe('off');
    expect(getRoute('chatgpt-subscription', settings).defaultEffort).toBe('high');
  });

  test('unknown route id is a typed route_unavailable error', () => {
    try {
      getRoute('claude-subscription');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).code).toBe('route_unavailable');
    }
  });

  test('image support is declared per route', () => {
    expect(imageRoutes()).toEqual(['openrouter-api', 'anthropic-api', 'openai-api']);
    expect(routeSupportsImages('chatgpt-subscription')).toBe(false);
    expect(routeSupportsImages('nope')).toBe(false);
  });
});

describe('validateRouteSelection', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof RouteError ? err.code : 'other';
    }
    return 'ok';
  };

  test('auto and absent resolve to route defaults', () => {
    const route = getRoute('anthropic-api', { thinking: { effort: 'medium' } });
    expect(validateRouteSelection(route, { model: 'auto', effort: 'auto' })).toEqual({
      model: 'claude-haiku-4-5-20251001',
      effort: 'medium',
    });
    expect(validateRouteSelection(route)).toEqual({
      model: 'claude-haiku-4-5-20251001',
      effort: 'medium',
    });
  });

  test('unknown-but-plausible models pass through', () => {
    expect(validateRouteSelection(getRoute('grok-api'), { model: 'grok-5' }).model).toBe('grok-5');
    expect(
      validateRouteSelection(getRoute('openrouter-api'), { model: 'qwen/qwen3-max' }).model,
    ).toBe('qwen/qwen3-max');
  });

  test('known-incompatible models are model_unsupported', () => {
    expect(code(() => validateRouteSelection(getRoute('grok-api'), { model: 'x-ai/grok-4' }))).toBe(
      'model_unsupported',
    );
    expect(
      code(() => validateRouteSelection(getRoute('chatgpt-subscription'), { model: 'grok-4.6' })),
    ).toBe('model_unsupported');
    expect(code(() => validateRouteSelection(getRoute('anthropic-api'), { model: 'gpt-4o' }))).toBe(
      'model_unsupported',
    );
    expect(
      code(() =>
        validateRouteSelection(getRoute('openrouter-api'), { model: 'claude-haiku-4-5-20251001' }),
      ),
    ).toBe('model_unsupported');
    expect(code(() => validateRouteSelection(getRoute('openai-api'), { model: '' }))).toBe(
      'model_unsupported',
    );
    expect(code(() => validateRouteSelection(getRoute('openai-api'), { model: 'a b' }))).toBe(
      'model_unsupported',
    );
  });

  test('unsupported or unknown effort is effort_unsupported, never dropped', () => {
    expect(
      code(() => validateRouteSelection(getRoute('chatgpt-subscription'), { effort: 'off' })),
    ).toBe('effort_unsupported');
    expect(
      code(() =>
        validateRouteSelection(getRoute('openai-api'), { model: 'gpt-4o', effort: 'low' }),
      ),
    ).toBe('effort_unsupported');
    expect(code(() => validateRouteSelection(getRoute('anthropic-api'), { effort: 'turbo' }))).toBe(
      'effort_unsupported',
    );
    expect(
      validateRouteSelection(getRoute('openai-api'), { model: 'gpt-5', effort: 'high' }).effort,
    ).toBe('high');
    expect(
      validateRouteSelection(getRoute('openrouter-api'), {
        model: 'anthropic/claude-sonnet-4.5',
        effort: 'max',
      }).effort,
    ).toBe('max');
  });
});

describe('inspectRouteCredential', () => {
  test('API-key presence follows env/config precedence and never echoes the key', async () => {
    const route = getRoute('grok-api');
    expect(await inspectRouteCredential(route, { env: {} })).toEqual({
      credentialState: 'missing',
      refreshable: false,
    });
    expect(
      await inspectRouteCredential(route, { env: { XAI_API_KEY: FAKE_KEYS.XAI_API_KEY } }),
    ).toEqual({ credentialState: 'present', refreshable: false });
    expect(
      await inspectRouteCredential(route, {
        env: {},
        settings: { providers: { xai: { apiKey: FAKE_KEYS.XAI_API_KEY } } },
      }),
    ).toEqual({ credentialState: 'present', refreshable: false });
    // An OpenRouter key never makes the direct xAI route present.
    expect(
      (
        await inspectRouteCredential(route, {
          env: { OPENROUTER_API_KEY: FAKE_KEYS.OPENROUTER_API_KEY },
        })
      ).credentialState,
    ).toBe('missing');
  });

  test('subscription states from an injected Keychain port', async () => {
    const route = getRoute('chatgpt-subscription');
    const at = { now: () => NOW };
    const state = async (record: SubscriptionRecord | null | Error) =>
      inspectRouteCredential(route, { ...at, subscriptionPort: fakePort(record) });
    expect(await state(null)).toEqual({ credentialState: 'missing', refreshable: false });
    expect(await state(LIVE)).toEqual({ credentialState: 'present', refreshable: true });
    expect(await state({ ...LIVE, expiresAt: NOW - 1 })).toEqual({
      credentialState: 'expired',
      refreshable: true,
    });
    expect(await state({ ...LIVE, expiresAt: NOW - 1, refreshToken: '' })).toEqual({
      credentialState: 'expired',
      refreshable: false,
    });
    expect(await state(new SubscriptionRecordUnreadableError('SOV_SUB_CHATGPT'))).toEqual({
      credentialState: 'unreadable',
      refreshable: false,
    });
    expect(
      await state(new CredentialStoreUnavailableError('SOV_SUB_CHATGPT', 'read_failed')),
    ).toEqual({ credentialState: 'unavailable', refreshable: false });
  });

  test('a hung Keychain read times out as unavailable, not missing', async () => {
    const hung: SubscriptionCredentialPort = {
      read: () => new Promise(() => {}),
      write: async () => {},
      delete: async () => {},
    };
    const started = Date.now();
    const status = await inspectRouteCredential(getRoute('grok-subscription'), {
      subscriptionPort: hung,
      timeoutMs: 50,
    });
    expect(status.credentialState).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('reads the matching Keychain service only', async () => {
    const port = fakePort(LIVE);
    await inspectRouteCredential(getRoute('grok-subscription'), { subscriptionPort: port });
    expect(port.reads).toEqual(['SOV_SUB_GROK']);
  });
});

describe('resolveRouteProvider', () => {
  const base = { harnessHome: tempHome(), settings: {}, env: FAKE_KEYS };

  test('every route resolves to its declared backend and auth (A1)', async () => {
    const expected = {
      'openrouter-api': {
        name: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        auth: 'api_key',
      },
      'anthropic-api': { name: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'api_key' },
      'openai-api': { name: 'openai', baseUrl: 'https://api.openai.com/v1', auth: 'api_key' },
      'grok-api': { name: 'xai', baseUrl: 'https://api.x.ai/v1', auth: 'api_key' },
      'chatgpt-subscription': {
        name: 'chatgpt',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        auth: 'oauth',
      },
      'grok-subscription': { name: 'grok', baseUrl: 'https://api.x.ai/v1', auth: 'oauth' },
    } as const;
    for (const id of ROUTE_IDS) {
      const result = await resolveRouteProvider(id, {
        ...base,
        subscriptionPort: fakePort(LIVE),
      });
      expect(result.provider.name).toBe(expected[id].name);
      expect(result.resolved.baseUrl).toBe(expected[id].baseUrl);
      expect(result.resolved.authType).toBe(expected[id].auth);
      expect(result.resolved.metadata.provider).toBe(result.route.provider);
      expect(result.model).toBe(result.route.defaultModel);
    }
  });

  test('grok-api with only an OpenRouter key is credential_missing, not OpenRouter', async () => {
    await expect(
      resolveRouteProvider('grok-api', {
        ...base,
        env: { OPENROUTER_API_KEY: FAKE_KEYS.OPENROUTER_API_KEY },
      }),
    ).rejects.toMatchObject({ code: 'credential_missing' });
  });

  test('subscription without a login is credential_missing and names the login command', async () => {
    const err = await resolveRouteProvider('chatgpt-subscription', {
      ...base,
      subscriptionPort: fakePort(null),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err.code).toBe('credential_missing');
    expect(err.message).toContain('sov login chatgpt');
  });

  test('a Keychain failure is credential_unavailable', async () => {
    await expect(
      resolveRouteProvider('grok-subscription', {
        ...base,
        subscriptionPort: fakePort(
          new CredentialStoreUnavailableError('SOV_SUB_GROK', 'read_failed'),
        ),
      }),
    ).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  test('expired login without a refresh token is auth_expired; with one it resolves', async () => {
    await expect(
      resolveRouteProvider('grok-subscription', {
        ...base,
        subscriptionPort: fakePort({ ...LIVE, expiresAt: 1, refreshToken: '' }),
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
    const ok = await resolveRouteProvider('grok-subscription', {
      ...base,
      subscriptionPort: fakePort({ ...LIVE, expiresAt: 1 }),
    });
    expect(ok.provider.name).toBe('grok');
  });

  test('a gateway principal is refused before the Keychain is read', async () => {
    const port = fakePort(LIVE);
    await expect(
      resolveRouteProvider('chatgpt-subscription', {
        ...base,
        principal: 'telegram:42',
        subscriptionPort: port,
      }),
    ).rejects.toMatchObject({ code: 'route_unavailable' });
    expect(port.reads).toEqual([]);
  });

  test('validation runs before any credential lookup', async () => {
    const port = fakePort(LIVE);
    await expect(
      resolveRouteProvider('chatgpt-subscription', {
        ...base,
        effort: 'off',
        subscriptionPort: port,
      }),
    ).rejects.toMatchObject({ code: 'effort_unsupported' });
    expect(port.reads).toEqual([]);
  });

  test('explicit model is honored and carried to the provider resolution', async () => {
    const result = await resolveRouteProvider('openrouter-api', {
      ...base,
      model: 'x-ai/grok-4',
    });
    expect(result.resolved.model).toBe('x-ai/grok-4');
    expect(result.provider.name).toBe('openrouter');
  });
});

describe('routeErrorCodeFor', () => {
  test('maps provider errors to stable codes', () => {
    const cases: Array<[unknown, string]> = [
      [new RouteError('effort_unsupported', 'x'), 'effort_unsupported'],
      [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'interrupted'],
      [new SubscriptionLoginMissingError('chatgpt'), 'credential_missing'],
      [new SubscriptionTierBlockedError('grok'), 'tier_blocked'],
      [new SubscriptionAuthExpiredError('chatgpt'), 'auth_expired'],
      [new SubscriptionRecordUnreadableError('chatgpt'), 'auth_expired'],
      [new CredentialStoreUnavailableError('chatgpt', 'write_failed'), 'credential_unavailable'],
      [new ClaudeMaxTermsError('no'), 'route_unavailable'],
      [new CredentialUnavailableError('xai'), 'credential_missing'],
      [new PersistBeforeRunError(), 'storage_failed'],
      [new ContextOverflowError('grok'), 'context_overflow'],
      [new SubscriptionHttpError('chatgpt', 429), 'rate_limited'],
      [new SubscriptionHttpError('chatgpt', 500), 'provider_failed'],
      [new ProviderHttpError('openai', 429, 'slow down'), 'rate_limited'],
      [new ProviderHttpError('openai', 404, 'gone'), 'model_unsupported'],
      [new ProviderHttpError('openai', 401, 'bad key'), 'auth_expired'],
      [Object.assign(new Error('rate'), { status: 429 }), 'rate_limited'],
      [new Error('prompt is too long: 1 > 0'), 'context_overflow'],
      [new Error('boom'), 'provider_failed'],
    ];
    for (const [err, expected] of cases) {
      expect(routeErrorCodeFor(err)).toBe(expected as never);
    }
  });

  test('the code list matches the spec §5.3 vocabulary', () => {
    expect([...ROUTE_ERROR_CODES]).toEqual([
      'invalid_input',
      'route_unavailable',
      'model_unsupported',
      'effort_unsupported',
      'credential_missing',
      'auth_expired',
      'credential_unavailable',
      'tier_blocked',
      'rate_limited',
      'context_overflow',
      'unsupported_input',
      'interrupted',
      'storage_failed',
      'provider_failed',
    ]);
  });
});
