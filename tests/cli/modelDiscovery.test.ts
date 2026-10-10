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
