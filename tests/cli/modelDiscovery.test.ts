import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ModelCatalog,
  createModelDiscovery,
  fallbackModelCatalog,
} from '@yevgetman/sov-sdk/providers/models/index';
import {
  apiKeyCredentialCount,
  resolveProvider,
} from '../../packages/sdk/src/providers/resolver.js';
import {
  diskModelCache,
  modelPage,
  modelSource,
  readModelCatalogSnapshot,
} from '../../src/cli/modelDiscovery.js';

test('bounded pagination and author are independent of inference host', () => {
  const catalog: ModelCatalog = {
    version: 1,
    routeId: 'openrouter-api',
    state: 'current',
    models: [1, 2, 3].map((n) => ({
      id: `author/model${n}`,
      displayName: `Model ${n}`,
      author: 'author',
      provider: 'openrouter',
      auth: 'api_key',
      routeId: 'openrouter-api',
      availability: 'advertised',
      capabilities: {
        textOutput: 'supported',
        images: 'unknown',
        tools: 'unknown',
        reasoning: 'unknown',
      },
      metadata: { source: 'fixture', stale: false },
    })),
  };
  expect(
    modelPage(catalog, { route: catalog.routeId, author: 'author', limit: 2 }).nextOffset,
  ).toBe(2);
  expect(modelPage(catalog, { route: catalog.routeId, search: 'model3' }).total).toBe(1);
  expect(() => modelPage(catalog, { route: catalog.routeId, limit: 100000 })).toThrow();
  expect(
    modelPage(fallbackModelCatalog('openrouter-api'), {
      route: 'openrouter-api',
      author: 'anthropic',
    }).total,
  ).toBeGreaterThan(0);
});

test('cache persists nonsecret snapshots and corrupt or mismatched data degrades offline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sov-model-cache-'));
  try {
    const cache = diskModelCache(root);
    const source = {
      routeId: 'openrouter-api',
      async discover() {
        return [];
      },
    };
    const first = await createModelDiscovery({ cache }).refresh(source);
    expect(first.state).toBe('current');
    expect((await createModelDiscovery({ cache }).read(source)).state).toBe('current');
    await cache.set('openrouter-api:public', { ...first, version: 999 } as unknown as ModelCatalog);
    expect((await createModelDiscovery({ cache }).read(source)).state).toBe('unavailable');
    writeFileSync(join(root, 'unrelated.json'), 'not-json');
    expect(await cache.get('not-present')).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('account caches use selected direct credentials without exposing their text', () => {
  const first = modelSource(
    'openai-api',
    { providers: { openai: { credentials: [{ token: 'fake-a' }] } } },
    {},
  );
  const second = modelSource('openai-api', { providers: { openai: { apiKey: 'fake-b' } } }, {});
  expect(first.cacheKey).not.toBe(second.cacheKey);
  expect(first.cacheKey).not.toContain('fake-a');
  expect(
    modelSource(
      'openai-api',
      { providers: { openai: { apiKey: 'fake-a' } } },
      { OPENAI_API_KEY: '' },
    ).cacheKey,
  ).toBe(first.cacheKey);
});

test('CLI rejects unsafe pagination before explicit refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sov-model-cli-'));
  try {
    const preload = join(root, 'no-network.ts');
    writeFileSync(
      preload,
      "globalThis.fetch = () => { throw new Error('unexpected network'); };\n",
    );
    for (const args of [
      ['models', '--route', 'openrouter-api', '--json'],
      ['models', '--route', 'openrouter-api', '--refresh', '--limit', '999999', '--json'],
    ]) {
      const child = Bun.spawn([process.execPath, '--preload', preload, 'src/main.ts', ...args], {
        env: { PATH: process.env.PATH, HOME: root, HARNESS_HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(args.includes('--refresh') ? 2 : 0);
      const result = JSON.parse(stdout);
      expect(result.schemaVersion).toBe(1);
      expect(stderr).not.toContain('unexpected network');
      if (args.includes('--refresh')) expect(result.error.code).toBe('invalid_model_query');
      else expect(result.state).toBe('unavailable');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recent unavailable metadata is stale before limit consumers read it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sov-model-state-'));
  try {
    const cache = diskModelCache(root);
    const source = modelSource('openrouter-api');
    const catalog = fallbackModelCatalog('openrouter-api');
    catalog.fetchedAt = new Date().toISOString();
    for (const model of catalog.models) model.metadata.stale = false;
    await cache.set('openrouter-api:public', catalog);
    const read = await createModelDiscovery({ cache }).read(source);
    expect(read.state).toBe('unavailable');
    expect(read.models.every((model) => model.metadata.stale)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit node homes read their own offline model limits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sov-model-node-home-'));
  try {
    const catalog = fallbackModelCatalog('openrouter-api');
    catalog.state = 'current';
    catalog.fetchedAt = new Date().toISOString();
    const first = catalog.models[0];
    if (!first) throw new Error('missing bundled fixture');
    first.contextWindow = 8000000;
    first.metadata = { source: 'fixture', stale: false, fetchedAt: catalog.fetchedAt };
    await diskModelCache(join(root, 'model-catalog')).set('openrouter-api:public', catalog);
    const own = readModelCatalogSnapshot('openrouter-api', {}, root);
    expect(own.models[0]?.contextWindow).toBe(8000000);
    expect(own.models[0]?.metadata.stale).toBe(false);
    expect(
      readModelCatalogSnapshot('openrouter-api', {}, join(root, 'other-node')).models[0]
        ?.contextWindow,
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('custom OpenRouter endpoints cannot reuse official model limits or pricing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sov-model-endpoint-'));
  let fetches = 0;
  const fetch = (async () => {
    fetches++;
    throw new Error('custom discovery must not fetch');
  }) as unknown as typeof globalThis.fetch;
  try {
    const cache = diskModelCache(join(root, 'model-catalog'));
    const catalog = fallbackModelCatalog('openrouter-api');
    catalog.state = 'current';
    catalog.fetchedAt = new Date().toISOString();
    const first = catalog.models[0];
    if (!first) throw new Error('missing model fixture');
    first.contextWindow = 8_000_000;
    first.metadata = { source: 'official-fixture', stale: false };
    first.pricing = { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD', source: 'fixture' };
    await cache.set('openrouter-api:public', catalog);
    const settings = { providers: { openrouter: { baseUrl: 'https://private.example/v1' } } };
    const source = modelSource('openrouter-api', settings);
    expect(source.cacheKey).toMatch(/^endpoint-[a-f0-9]{64}$/);
    expect(source.cacheKey).not.toContain('private.example');
    expect(
      modelSource('openrouter-api', {
        providers: { openrouter: { baseUrl: 'https://different.example/v1' } },
      }).cacheKey,
    ).not.toBe(source.cacheKey);
    const discovery = createModelDiscovery({ cache, fetch });
    for (const result of [
      await discovery.read(source),
      readModelCatalogSnapshot('openrouter-api', settings, root),
      await discovery.refresh(source),
    ]) {
      expect(result.state).toBe('unavailable');
      expect(result.models.every((model) => model.metadata.stale)).toBe(true);
      expect(result.models.every((model) => model.contextWindow === undefined)).toBe(true);
      expect(result.models.every((model) => model.pricing === undefined)).toBe(true);
    }
    expect(fetches).toBe(0);
    expect((await cache.get('openrouter-api:public'))?.models[0]?.contextWindow).toBe(8_000_000);
    for (const baseUrl of ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/']) {
      const official = { providers: { openrouter: { baseUrl } } };
      const source = modelSource('openrouter-api', official);
      expect(source.cacheKey).toBeUndefined();
      expect((await discovery.read(source)).models[0]?.contextWindow).toBe(8_000_000);
      expect(readModelCatalogSnapshot('openrouter-api', official, root).state).toBe('current');
    }
    for (const baseUrl of [
      'https://openrouter.ai/api/v1?proxy=1',
      'https://openrouter.ai/api/v1?',
      'https://openrouter.ai/api/v1#',
      'https://user:secret@openrouter.ai/api/v1',
      'https://openrouter.ai/private',
      'http://openrouter.ai/api/v1',
    ]) {
      expect(
        modelSource('openrouter-api', { providers: { openrouter: { baseUrl } } }).cacheKey,
      ).toMatch(/^endpoint-/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pooled direct credentials cannot borrow first-account metadata', async () => {
  // An in-memory cache avoids using any real credential state or configuration.
  const memory = new Map<string, ModelCatalog>();
  const isolated = {
    async get(key: string) {
      return memory.get(key);
    },
    async set(key: string, value: ModelCatalog) {
      memory.set(key, value);
    },
  };
  const single = modelSource(
    'openai-api',
    { providers: { openai: { apiKey: 'fake-account-a' } } },
    {},
  );
  const catalog = fallbackModelCatalog('openai-api');
  catalog.state = 'current';
  catalog.fetchedAt = new Date().toISOString();
  const first = catalog.models[0];
  if (!first) throw new Error('missing model fixture');
  first.contextWindow = 8_000_000;
  first.metadata = { source: 'account-a-fixture', stale: false };
  await isolated.set(`openai-api:${single.cacheKey}`, catalog);
  let calls = 0;
  const discovery = createModelDiscovery({
    cache: isolated,
    fetch: (async () => {
      calls++;
      throw new Error('ambiguous discovery must not fetch');
    }) as unknown as typeof globalThis.fetch,
  });
  const configurations = [
    { apiKeys: ['fake-account-a', 'fake-account-b'] },
    { apiKey: 'fake-account-a', credentials: [{ apiKey: 'fake-account-b', priority: 0 }] },
    {
      credentials: [
        { id: 'a', apiKey: 'fake-account-a', priority: 100 },
        { id: 'b', token: 'fake-account-b', priority: 0 },
      ],
    },
  ];
  for (const config of configurations) {
    const source = modelSource('openai-api', { providers: { openai: config } }, {});
    expect(source.cacheKey).toBe('ambiguous-account-pool');
    for (const result of [await discovery.read(source), await discovery.refresh(source)]) {
      expect(result.state).toBe('unavailable');
      expect(result.models.every((model) => model.contextWindow === undefined)).toBe(true);
      expect(result.models.every((model) => model.metadata.stale)).toBe(true);
    }
  }
  expect(
    modelSource(
      'openai-api',
      { providers: { openai: { apiKey: 'fake-account-b' } } },
      { OPENAI_API_KEY: 'fake-account-a' },
    ).cacheKey,
  ).toBe('ambiguous-account-pool');
  expect(
    modelSource(
      'openai-api',
      { providers: { openai: { apiKey: 'fake-account-a', apiKeys: ['fake-account-a'] } } },
      {},
    ).cacheKey,
  ).toBe(single.cacheKey);
  expect(calls).toBe(0);
});

test('discovery ambiguity follows the runtime credential pool without touching disk', () => {
  const settings = { providers: { openai: { apiKey: 'fake-config-b' } } };
  const env = { OPENAI_API_KEY: 'fake-env-a' };
  expect(apiKeyCredentialCount('openai', settings, env)).toBe(2);
  expect(
    resolveProvider('openai', 'gpt-5', { settings, env, credentialState: 'memory' }).metadata
      .credentialId,
  ).toBe('OPENAI_API_KEY');
  expect(modelSource('openai-api', settings, env).cacheKey).toBe('ambiguous-account-pool');
  const priority = {
    providers: {
      openai: {
        credentials: [
          { id: 'a', apiKey: 'fake-a', priority: 100 },
          { id: 'b', apiKey: 'fake-b', priority: 0 },
        ],
      },
    },
  };
  expect(
    resolveProvider('openai', 'gpt-5', { settings: priority, env: {}, credentialState: 'memory' })
      .metadata.credentialId,
  ).toBe('b');
  expect(modelSource('openai-api', priority, {}).cacheKey).toBe('ambiguous-account-pool');
  const empty = {
    providers: { openai: { credentials: [{ apiKey: '', token: 'fake-ignored-token' }] } },
  };
  expect(apiKeyCredentialCount('openai', empty, {})).toBe(0);
  expect(modelSource('openai-api', empty, {}).cacheKey).toBe('unconfigured');
});
