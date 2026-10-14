import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PickerOpenConfig } from '../../../packages/sdk/src/commands/types';
import { query } from '../../../packages/sdk/src/core/query';
import { ChatGptSubscriptionProvider } from '../../../packages/sdk/src/providers/chatgpt';
import { contextLengthFor } from '../../../packages/sdk/src/providers/models';
import { findModel } from '../../../packages/sdk/src/providers/models/index';
import { validateOwnerChatGptRegistry } from '../../../packages/sdk/src/providers/models/ownerRegistry';
import type { ModelCatalog, ModelRecord } from '../../../packages/sdk/src/providers/models/types';
import { validateModelRequest } from '../../../packages/sdk/src/providers/models/validateRequest';
import { getRoute, validateRouteSelection } from '../../../packages/sdk/src/providers/routes/index';
import {
  advanceCredentialGeneration,
  withCredentialLock,
} from '../../../packages/sdk/src/providers/subscription/lock';
import {
  loginSubscription,
  logoutSubscription,
} from '../../../packages/sdk/src/providers/subscription/login';
import {
  rotateSubscriptionLoginEpoch,
  subscriptionLoginEpoch,
} from '../../../packages/sdk/src/providers/subscription/loginEpoch';
import { KEYCHAIN_SERVICE } from '../../../packages/sdk/src/providers/subscription/names';
import type { SubscriptionCredentialPort } from '../../../packages/sdk/src/providers/subscription/port';
import type { ProviderRequest } from '../../../packages/sdk/src/providers/types';
import { modelPage, routeWithOwnerModels } from '../../../src/cli/modelDiscovery';
import {
  importOwnerChatGptRegistry,
  readOwnerChatGptRegistry,
  readOwnerGrokRegistry,
} from '../../../src/cli/ownerModelRegistry';
import { dispatchSlashCommand } from '../../../src/commands/registry';
import { selectedTurnModel } from '../../../src/server/modelMetadata';
import { makeCtx } from '../../commands/_makeCtx';

const at = '2026-10-13T00:00:00.000Z';
const now = Date.parse(at) + 1000;
function record(id = 'chatgpt-future-owner'): ModelRecord {
  return {
    id,
    displayName: id,
    provider: 'chatgpt',
    auth: 'subscription',
    routeId: 'chatgpt-subscription',
    capabilities: {
      textOutput: 'supported',
      tools: 'supported',
      images: 'supported',
      reasoning: 'supported',
    },
    contextWindow: 600_000,
    maxOutputTokens: 25_000,
    efforts: ['low', 'high', 'max'],
    availability: 'unknown',
    metadata: { source: 'owner-reviewed-codex-fixture', fetchedAt: at, stale: false },
  };
}
function registry(models = [record()]): ModelCatalog {
  return { version: 1, routeId: 'chatgpt-subscription', state: 'current', fetchedAt: at, models };
}
function fakePort(dir?: string, account = 'owner-a'): SubscriptionCredentialPort {
  let loggedIn = true;
  return {
    ...(dir ? { lockDirectory: dir } : {}),
    lockIdentity: account,
    async read() {
      return loggedIn
        ? {
            accessToken: 'FAKE-CREDENTIAL',
            refreshToken: 'FAKE-REFRESH',
            expiresAt: Date.now() + 1000000,
          }
        : null;
    },
    async write() {
      loggedIn = true;
    },
    async delete() {
      loggedIn = false;
    },
  };
}
const req: ProviderRequest = {
  model: 'chatgpt-future-owner',
  system: [],
  messages: [],
  maxTokens: 100,
  effort: 'max',
};

test('registry validates exact route metadata, provenance, dates, limits and effort values', () => {
  const result = validateOwnerChatGptRegistry(registry(), now);
  expect(result.models[0]?.metadata).toMatchObject({
    ownerManaged: true,
    source: record().metadata.source,
    fetchedAt: at,
  });
  for (const bad of [
    { ...registry(), routeId: 'chatgpt-api' },
    { ...registry(), fetchedAt: 2026 },
    registry([{ ...record(), availability: 'account' }]),
    registry([{ ...record(), auth: 'api_key' }]),
    registry([{ ...record(), contextWindow: -1 }]),
    registry([{ ...record(), maxOutputTokens: 700000 }]),
    registry([
      { ...record(), metadata: { source: 'Bearer FAKE-CREDENTIAL', stale: false, fetchedAt: at } },
    ]),
    registry([{ ...record(), metadata: { source: 'docs', stale: false } }]),
    registry([{ ...record(), efforts: ['off'] }]),
    registry([
      {
        ...record(),
        efforts: ['max'],
        capabilities: { ...record().capabilities, reasoning: 'unknown' },
      },
    ]),
    registry([{ ...record(), id: 'chatgpt bad' }]),
    registry([{ ...record(), efforts: 'high' } as unknown as ModelRecord]),
    registry([{ ...record(), capabilities: 'supported' } as unknown as ModelRecord]),
    registry([
      { ...record(), metadata: { source: 'docs', stale: false, fetchedAt: '2099-01-01' } },
    ]),
  ])
    expect(() => validateOwnerChatGptRegistry(bad, now)).toThrow(/Invalid ChatGPT owner/);
});

test('missing limits and capability facts remain unknown and do not borrow a shipped pin', () => {
  const minimal = {
    ...record('gpt-5.3-codex'),
    contextWindow: undefined,
    maxOutputTokens: undefined,
    efforts: undefined,
    capabilities: {
      textOutput: 'unknown',
      tools: 'unknown',
      images: 'unknown',
      reasoning: 'unknown',
    },
  } as ModelRecord;
  const catalog = validateOwnerChatGptRegistry(registry([minimal]), now);
  const found = findModel(catalog, 'gpt-5.3-codex');
  expect(found.contextWindow).toBeUndefined();
  expect(found.maxOutputTokens).toBeUndefined();
  expect(found.efforts).toBeUndefined();
  expect(found.capabilities).toEqual(minimal.capabilities);
  expect(() =>
    validateRouteSelection(getRoute('chatgpt-subscription'), {
      model: found.id,
      modelMetadata: found,
    }),
  ).toThrow(/effort/);
});

test('retired owner records including shipped pins are tombstones, not picker rows', () => {
  const retired = { ...record('gpt-5.3-codex'), metadata: { ...record().metadata, retired: true } };
  const catalog = validateOwnerChatGptRegistry(registry([record(), retired]), now);
  expect(findModel(catalog, 'gpt-5.3-codex').metadata.retired).toBe(true);
  expect(() =>
    validateRouteSelection(getRoute('chatgpt-subscription'), {
      model: 'gpt-5.3-codex',
      modelMetadata: findModel(catalog, 'gpt-5.3-codex'),
    }),
  ).toThrow(/retired/);
  const page = modelPage(catalog, { route: 'chatgpt-subscription' });
  expect(page.models.map((model) => model.id)).toEqual(['chatgpt-future-owner']);
  expect(page).toMatchObject({ retiredModels: ['gpt-5.3-codex'], catalogKind: 'owner-managed' });
  const route = routeWithOwnerModels(
    getRoute('chatgpt-subscription', {
      routes: { 'chatgpt-subscription': { defaultModel: 'gpt-5.3-codex' } },
    }),
    catalog,
  );
  expect(route.rejectedConfiguredDefault).toBe('gpt-5.3-codex');
  expect(route.models).not.toContain('gpt-5.3-codex');
});

test('owner future ID reaches subscription fetch with exact model, tools and xhigh; no API key route', async () => {
  const modelMetadata = validateOwnerChatGptRegistry(registry(), now).models[0] as ModelRecord;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const provider = new ChatGptSubscriptionProvider({
    port: fakePort(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const request = {
    ...req,
    modelMetadata,
    tools: [
      {
        name: 'check',
        description: 'Check fixture',
        input_schema: { type: 'object' as const, properties: {} },
      },
    ],
  };
  const selection = validateRouteSelection(getRoute('chatgpt-subscription'), {
    model: req.model,
    effort: 'max',
    modelMetadata,
  });
  expect(selection.model).toBe(req.model);
  for await (const _event of provider.stream(request)) {
  }
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(calls[0]?.body).toMatchObject({ model: req.model, reasoning: { effort: 'xhigh' } });
  expect(calls[0]?.body.tools).toBeDefined();
  expect(() =>
    validateModelRequest(
      {
        ...req,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'fixture' },
              },
            ],
          },
        ],
      },
      'chatgpt',
      modelMetadata,
    ),
  ).toThrow(/no verified image serializer/);
});

test('disk registry survives token refresh, stays stale offline, is atomic on invalid import and isolates accounts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sov-owner-registry-'));
  const port = fakePort(join(home, 'locks'));
  try {
    await importOwnerChatGptRegistry(registry(), { harnessHome: home, port, now });
    const epoch = subscriptionLoginEpoch(port, KEYCHAIN_SERVICE.chatgpt);
    expect(epoch).toBeDefined();
    const fresh = readOwnerChatGptRegistry(home, port, now) as ModelCatalog;
    expect(fresh.state).toBe('current');
    const selected = findModel(fresh, req.model);
    expect(
      validateRouteSelection(getRoute('chatgpt-subscription'), {
        model: req.model,
        effort: 'max',
        modelMetadata: selected,
      }).model,
    ).toBe(req.model);
    await withCredentialLock(KEYCHAIN_SERVICE.chatgpt, port, () =>
      advanceCredentialGeneration(port, KEYCHAIN_SERVICE.chatgpt),
    );
    expect(subscriptionLoginEpoch(port, KEYCHAIN_SERVICE.chatgpt)).toBe(epoch);
    const stale = readOwnerChatGptRegistry(home, port, now + 3600000) as ModelCatalog;
    expect(stale.state).toBe('stale');
    expect(stale.models[0]?.metadata.stale).toBe(true);
    expect(contextLengthFor('chatgpt', req.model, stale.models[0])).toBe(600_000);
    expect(
      validateRouteSelection(getRoute('chatgpt-subscription'), {
        model: req.model,
        effort: 'max',
        modelMetadata: stale.models[0] as ModelRecord,
      }).model,
    ).toBe(req.model);
    const dir = join(home, 'model-catalog', 'subscription', 'chatgpt-subscription');
    const before = readFileSync(join(dir, readdirSync(dir)[0] as string), 'utf8');
    expect(before).not.toContain('FAKE-CREDENTIAL');
    await expect(
      importOwnerChatGptRegistry(registry([{ ...record(), contextWindow: 0 }]), {
        harnessHome: home,
        port,
        now,
      }),
    ).rejects.toThrow(/Invalid/);
    expect(readFileSync(join(dir, readdirSync(dir)[0] as string), 'utf8')).toBe(before);
    expect(
      readOwnerChatGptRegistry(home, fakePort(join(home, 'locks'), 'owner-b'), now),
    ).toBeUndefined();
    // Supported account switch without optional catalog hooks invalidates across profiles.
    await withCredentialLock(KEYCHAIN_SERVICE.chatgpt, port, async () => {
      await rotateSubscriptionLoginEpoch(port, KEYCHAIN_SERVICE.chatgpt);
      await port.write(KEYCHAIN_SERVICE.chatgpt, {
        accessToken: 'SECOND',
        refreshToken: 'SECOND-REFRESH',
        expiresAt: now + 10000,
      });
    });
    expect(readOwnerChatGptRegistry(home, port, now)).toBeUndefined();
    await importOwnerChatGptRegistry(registry([record('chatgpt-second-account')]), {
      harnessHome: home,
      port,
      now,
    });
    await withCredentialLock(KEYCHAIN_SERVICE.chatgpt, port, () =>
      rotateSubscriptionLoginEpoch(port, KEYCHAIN_SERVICE.chatgpt),
    );
    expect(readOwnerChatGptRegistry(home, port, now)).toBeUndefined();
    await importOwnerChatGptRegistry(registry(), { harnessHome: home, port, now });
    await logoutSubscription('chatgpt', port, {
      stdout() {},
      stderr() {},
      openUrl() {},
      async sleep() {},
      now: () => now,
      fetchImpl: fetch,
    });
    expect(readOwnerChatGptRegistry(home, port, now)).toBeUndefined();
    await expect(
      importOwnerChatGptRegistry(registry(), { harnessHome: home, port, now }),
    ).rejects.toThrow(/requires a subscription login/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('row review freshness remains stale on import and owner flags do not expand foreign budgets', () => {
  const catalog = validateOwnerChatGptRegistry(
    { ...registry(), fetchedAt: new Date(now).toISOString() },
    now + 7200000,
  );
  expect(catalog.state).toBe('stale');
  expect(catalog.models[0]?.metadata.fetchedAt).toBe(at);
  expect(catalog.models[0]?.metadata.stale).toBe(true);
  const foreign = {
    ...record(),
    routeId: 'openai-api',
    provider: 'openai',
    auth: 'api_key',
    metadata: { ...record().metadata, stale: true, ownerManaged: true },
  } as ModelRecord;
  expect(contextLengthFor('openai', foreign.id, foreign)).toBe(32768);
});

test('CLI imports a new exact model offline and reports retired rows without source edits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sov-owner-cli-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const fake = JSON.stringify({
      accessToken: 'FIXTURE-ONLY',
      refreshToken: 'FIXTURE-ONLY',
      expiresAt: Date.now() + 1000000,
    });
    writeFileSync(join(bin, 'security'), `#!/bin/sh\nprintf '%s' '${fake}'\n`, { mode: 0o700 });
    const input = registry([
      record('chatgpt-cli-exact'),
      { ...record('gpt-5.3-codex'), metadata: { ...record().metadata, retired: true } },
    ]);
    const file = join(home, 'registry.json');
    writeFileSync(file, JSON.stringify(input));
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ routes: { 'chatgpt-subscription': { defaultModel: 'chatgpt-cli-exact' } } }),
    );
    const env = {
      ...process.env,
      HOME: home,
      HARNESS_HOME: home,
      HARNESS_CONFIG: join(home, 'config.json'),
      USER: 'sov-fixture-owner',
      LOGNAME: 'sov-fixture-owner',
      PATH: `${bin}:${process.env.PATH}`,
    };
    async function cli(args: string[]) {
      const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
        cwd: join(import.meta.dir, '../../..'),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const text = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(stderr).not.toContain('FIXTURE-ONLY');
      return JSON.parse(text);
    }
    const imported = await cli([
      'models',
      '--route',
      'chatgpt-subscription',
      '--registry',
      file,
      '--json',
    ]);
    expect(imported.models.map((model: ModelRecord) => model.id)).toEqual(['chatgpt-cli-exact']);
    expect(imported).toMatchObject({
      state: 'stale',
      catalogKind: 'owner-managed',
      retiredModels: ['gpt-5.3-codex'],
      sessionReset: { transcriptOnly: true, preserves: ['route', 'model', 'effort'] },
    });
    const routes = await cli(['routes', '--json']);
    const route = routes.routes.find(
      (entry: { id: string }) => entry.id === 'chatgpt-subscription',
    );
    expect(route.models).toContain('chatgpt-cli-exact');
    expect(route.models).not.toContain('gpt-5.3-codex');
    expect(route.rejectedConfiguredDefault).toBeUndefined();
    expect(route.defaultModel).toBe('chatgpt-cli-exact');
    const read = await cli(['models', '--route', 'chatgpt-subscription', '--json']);
    expect(read.models[0]).toMatchObject({
      id: 'chatgpt-cli-exact',
      contextWindow: 600000,
      metadata: { ownerManaged: true, stale: true },
    });
    const refreshed = await cli([
      'models',
      '--route',
      'chatgpt-subscription',
      '--refresh',
      '--json',
    ]);
    expect(refreshed.models.map((model: ModelRecord) => model.id)).toEqual(['chatgpt-cli-exact']);
    expect(refreshed.error.message).toContain('Re-import');
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(input));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('model and config pickers select a registry future ID and keep retired saved ID unavailable', async () => {
  if (process.env.SOV_OWNER_PICKER_FIXTURE !== '1') {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'sov-owner-picker-process-'));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          'test',
          import.meta.path,
          '--test-name-pattern',
          'model and config pickers',
        ],
        {
          env: { ...process.env, HOME: isolatedHome, SOV_OWNER_PICKER_FIXTURE: '1' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      if ((await child.exited) !== 0) throw new Error(output + errors);
      return;
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }

  const home = mkdtempSync(join(tmpdir(), 'sov-owner-pickers-'));
  const previousHome = process.env.HOME;
  const previousConfig = process.env.HARNESS_CONFIG;
  process.env.HOME = home;
  process.env.HARNESS_CONFIG = join(home, 'config.json');
  writeFileSync(
    process.env.HARNESS_CONFIG,
    JSON.stringify({ defaultProvider: 'chatgpt', defaultModel: 'gpt-5.3-codex' }),
  );
  try {
    const port = fakePort(
      join(homedir(), '.sov', 'auth-locks'),
      process.env.USER || process.env.LOGNAME || 'fixture-owner',
    );
    await importOwnerChatGptRegistry(
      registry([
        record(),
        { ...record('gpt-5.3-codex'), metadata: { ...record().metadata, retired: true } },
      ]),
      { harnessHome: home, port, now },
    );
    expect(readOwnerChatGptRegistry(home)).toBeDefined();
    const opened: PickerOpenConfig[] = [];
    let changed = '';
    const ctx = makeCtx({
      providerName: 'chatgpt',
      model: 'gpt-5.3-codex',
      harnessHome: home,
      getModelCatalogSettings: () => ({ defaultProvider: 'chatgpt' }),
      requestPicker: (config) => opened.push(config),
      setModel: (model) => {
        changed = model;
      },
    });
    await dispatchSlashCommand('/model', ctx);
    expect(opened[0]?.items.some((item) => item.value === 'chatgpt-future-owner')).toBe(true);
    expect(opened[0]?.items.some((item) => item.value === 'gpt-5.3-codex')).toBe(false);
    expect(opened[0]?.items.some((item) => item.value === '--keep-current')).toBe(true);
    expect(opened[0]?.subtitle).toContain('/new keeps saved route/model/effort');
    await dispatchSlashCommand('/model chatgpt-future-owner', ctx);
    expect(changed).toBe('chatgpt-future-owner');
    expect(ctx.providerName).toBe('chatgpt');
    await dispatchSlashCommand('/config edit defaultModel', ctx);
    expect(opened.at(-1)?.items.some((item) => item.value === 'chatgpt-future-owner')).toBe(true);
    expect(opened.at(-1)?.items.some((item) => item.value === 'gpt-5.3-codex')).toBe(false);
  } finally {
    if (previousHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = previousConfig;
    rmSync(home, { recursive: true, force: true });
  }
});

test('Kernel-sized input reaches ChatGPT with reviewed stale limits; unknown tokenizer stays advisory', async () => {
  const metadata = validateOwnerChatGptRegistry(registry(), now + 7200000).models[0] as ModelRecord;
  expect(
    selectedTurnModel('chatgpt', metadata.id, { modelMetadata: metadata })?.limits.contextTokens,
  ).toBe(600000);
  let calls = 0;
  const provider = new ChatGptSubscriptionProvider({
    port: fakePort(),
    fetchImpl: async () => {
      calls++;
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  async function run(modelMetadata: ModelRecord) {
    const loop = query({
      provider,
      model: metadata.id,
      modelMetadata,
      effort: 'high',
      maxTokens: 100,
      systemPrompt: [{ text: 'K'.repeat(70000), cacheable: false }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }],
    });
    for (;;) {
      const step = await loop.next();
      if (step.done) return step.value;
    }
  }
  expect((await run(metadata)).reason).toBe('completed');
  expect(calls).toBe(1);
  expect(
    (await run({ ...metadata, contextWindow: undefined, maxOutputTokens: undefined })).reason,
  ).toBe('completed');
  expect(calls).toBe(2);
});

test('re-import changes exact limits and efforts without a package release or settings write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sov-chatgpt-update-'));
  const port = fakePort(join(home, 'locks'));
  try {
    await importOwnerChatGptRegistry(registry(), { harnessHome: home, port, now });
    await importOwnerChatGptRegistry(
      registry([{ ...record(), contextWindow: 800000, maxOutputTokens: 30000, efforts: ['high'] }]),
      { harnessHome: home, port, now },
    );
    const metadata = readOwnerChatGptRegistry(home, port, now)?.models[0] as ModelRecord;
    expect(contextLengthFor('chatgpt', metadata.id, metadata)).toBe(800000);
    expect(metadata.maxOutputTokens).toBe(30000);
    expect(() =>
      validateRouteSelection(getRoute('chatgpt-subscription'), {
        model: metadata.id,
        effort: 'max',
        modelMetadata: metadata,
      }),
    ).toThrow(/effort/);
    expect(readdirSync(home)).not.toContain('config.json');
    expect(readOwnerGrokRegistry(home, port, now)).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ChatGPT account A to B to A successful device logins invalidate registries across profiles', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sov-chatgpt-login-'));
  const port = fakePort(join(home, 'locks'));
  async function login(account: string) {
    let call = 0;
    return loginSubscription('chatgpt', port, {
      stdout() {},
      stderr() {},
      openUrl() {},
      async sleep() {},
      now: () => now,
      fetchImpl: async () =>
        Response.json(
          ++call === 1
            ? { user_code: 'FIXTURE', device_auth_id: 'fixture', interval: 1 }
            : call === 2
              ? { authorization_code: 'fixture', code_verifier: 'fixture' }
              : {
                  access_token: `FIXTURE-${account}`,
                  refresh_token: `REFRESH-${account}`,
                  expires_in: 3600,
                },
        ),
    });
  }
  try {
    expect(await login('A')).toBe(0);
    await importOwnerChatGptRegistry(registry(), { harnessHome: home, port, now });
    const otherProfile = join(home, 'profile-b');
    await importOwnerChatGptRegistry(registry(), { harnessHome: otherProfile, port, now });
    expect(readOwnerChatGptRegistry(otherProfile, port, now)).toBeDefined();
    expect(await login('B')).toBe(0);
    expect(readOwnerChatGptRegistry(home, port, now)).toBeUndefined();
    expect(readOwnerChatGptRegistry(otherProfile, port, now)).toBeUndefined();
    await importOwnerChatGptRegistry(registry(), { harnessHome: otherProfile, port, now });
    expect(await login('A')).toBe(0);
    expect(readOwnerChatGptRegistry(otherProfile, port, now)).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('direct ChatGPT transport refuses unverified default wire effort before credential access', async () => {
  const metadata = validateOwnerChatGptRegistry(registry([{ ...record(), efforts: ['high'] }]), now)
    .models[0] as ModelRecord;
  let reads = 0;
  const provider = new ChatGptSubscriptionProvider({
    port: {
      async read() {
        reads++;
        return null;
      },
      async write() {},
      async delete() {},
    },
  });
  const { effort: _effort, ...request } = req;
  const stream = provider.stream({ ...request, modelMetadata: metadata });
  await expect(stream.next()).rejects.toThrow(/wire effort/);
  expect(reads).toBe(0);
});
