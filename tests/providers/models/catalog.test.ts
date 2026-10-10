import { describe, expect, test } from 'bun:test';
import {
  createModelDiscovery,
  fallbackModelCatalog,
  findModel,
} from '../../../packages/sdk/src/providers/models/index.js';
import type { ModelDiscoverySource } from '../../../packages/sdk/src/providers/models/index.js';

describe('portable model discovery', () => {
  test('offline suggestions and custom IDs never perform discovery', async () => {
    let calls = 0;
    const source: ModelDiscoverySource = {
      routeId: 'openai-api',
      async discover() {
        calls++;
        return [];
      },
    };
    const discovery = createModelDiscovery();
    expect((await discovery.read(source)).state).toBe('unavailable');
    expect(calls).toBe(0);
    expect(
      findModel(fallbackModelCatalog('custom-route'), 'future-unknown-model').capabilities.tools,
    ).toBe('unknown');
  });
  test('refreshes deduplicate, expire, retain deleted IDs and fail stale', async () => {
    let now = 1000;
    let calls = 0;
    let fail = false;
    const source: ModelDiscoverySource = {
      routeId: 'custom',
      async discover() {
        calls++;
        await Promise.resolve();
        if (fail) throw Error('sensitive provider body');
        return [findModel(fallbackModelCatalog('custom'), 'future-1')];
      },
    };
    const discovery = createModelDiscovery({ now: () => now, ttlMs: 100 });
    await Promise.all([discovery.refresh(source), discovery.refresh(source)]);
    expect(calls).toBe(1);
    expect((await discovery.read(source)).state).toBe('current');
    now = 1200;
    expect((await discovery.read(source)).state).toBe('stale');
    fail = true;
    const catalog = await discovery.refresh(source);
    expect(catalog.models[0]?.metadata.stale).toBe(true);
    expect(catalog.error).not.toContain('sensitive');
    expect(findModel(catalog, 'deleted-id').id).toBe('deleted-id');
  });
  test('timeout bounds sources that ignore cancellation', async () => {
    const source: ModelDiscoverySource = {
      routeId: 'custom',
      discover: () => new Promise(() => {}),
    };
    expect((await createModelDiscovery({ timeoutMs: 5 }).refresh(source)).state).toBe(
      'unavailable',
    );
  });
});

test('malformed/future/cross-route cache cannot certify metadata', async () => {
  const source: ModelDiscoverySource = {
    routeId: 'openai-api',
    async discover() {
      return [];
    },
  };
  const invalid = { ...fallbackModelCatalog('openai-api'), version: 2 };
  const discovery = createModelDiscovery({
    cache: {
      async get() {
        return invalid as never;
      },
      async set() {},
    },
  });
  expect((await discovery.read(source)).state).toBe('unavailable');
  const future = { ...fallbackModelCatalog('openai-api'), fetchedAt: '2999-01-01T00:00:00Z' };
  const futureDiscovery = createModelDiscovery({
    cache: {
      async get() {
        return future;
      },
      async set() {},
    },
  });
  expect((await futureDiscovery.read(source)).state).toBe('unavailable');
  const wrong = {
    routeId: 'openai-api',
    async discover() {
      return [findModel(fallbackModelCatalog('grok-api'), 'model')];
    },
  };
  expect((await createModelDiscovery().refresh(wrong)).state).toBe('unavailable');
});

test('catalog boundary drops arbitrary credential-shaped source properties', async () => {
  const model = {
    ...findModel(fallbackModelCatalog('custom'), 'id'),
    apiKey: 'must-not-leak',
    metadata: { source: 'fixture', stale: false, token: 'must-not-leak' },
  };
  const source: ModelDiscoverySource = {
    routeId: 'custom',
    async discover() {
      return [model];
    },
  };
  const catalog = await createModelDiscovery().refresh(source);
  expect(JSON.stringify(catalog)).not.toContain('must-not-leak');
});

test('failed refresh persists stale evidence for subsequent instances', async () => {
  const values = new Map<string, ReturnType<typeof fallbackModelCatalog>>();
  const cache = {
    async get(key: string) {
      return values.get(key);
    },
    async set(key: string, value: ReturnType<typeof fallbackModelCatalog>) {
      values.set(key, value);
    },
  };
  let fail = false;
  const source = {
    routeId: 'custom',
    async discover() {
      if (fail) throw new Error('offline');
      return [{ ...findModel(fallbackModelCatalog('custom'), 'future'), contextWindow: 8_000_000 }];
    },
  };
  const discovery = createModelDiscovery({ cache });
  await discovery.refresh(source);
  fail = true;
  expect((await discovery.refresh(source)).state).toBe('stale');
  const saved = await createModelDiscovery({ cache }).read(source);
  expect(saved.state).toBe('stale');
  expect(saved.models[0]?.metadata.stale).toBe(true);
  fail = false;
  expect((await discovery.refresh(source)).state).toBe('current');
  expect((await discovery.read(source)).models[0]?.metadata.stale).toBe(false);
});

test('failed stale persistence retains fail-safe invalidation in the same instance', async () => {
  let saved: ReturnType<typeof fallbackModelCatalog> | undefined;
  let fail = false;
  const cache = {
    async get() {
      return saved;
    },
    async set(_key: string, value: ReturnType<typeof fallbackModelCatalog>) {
      if (fail) throw new Error('disk unavailable');
      saved = value;
    },
  };
  const source = {
    routeId: 'custom',
    async discover() {
      if (fail) throw new Error('offline');
      return [findModel(fallbackModelCatalog('custom'), 'future')];
    },
  };
  const discovery = createModelDiscovery({ cache });
  await discovery.refresh(source);
  fail = true;
  await discovery.refresh(source);
  expect(saved?.state).toBe('current');
  expect((await discovery.read(source)).state).toBe('stale');
});

test('unresponsive cache ports are bounded and release deduplicated refreshes', async () => {
  let calls = 0;
  const source = {
    routeId: 'custom',
    async discover() {
      calls++;
      return [findModel(fallbackModelCatalog('custom'), 'future')];
    },
  };
  const discovery = createModelDiscovery({
    timeoutMs: 5,
    cache: { get: () => new Promise(() => {}), set: () => new Promise(() => {}) },
  });
  expect((await discovery.read(source)).state).toBe('unavailable');
  const [one, two] = await Promise.all([discovery.refresh(source), discovery.refresh(source)]);
  expect(one.state).toBe('unavailable');
  expect(two.state).toBe('unavailable');
  expect(calls).toBe(1);
  await discovery.refresh(source);
  expect(calls).toBe(2);
});

test('late cache writes cannot overwrite a newer successful refresh', async () => {
  let saved: ReturnType<typeof fallbackModelCatalog> | undefined;
  let completeFirst: (() => void) | undefined;
  let writes = 0;
  let calls = 0;
  const cache = {
    async get() {
      return saved;
    },
    async set(_key: string, value: ReturnType<typeof fallbackModelCatalog>) {
      writes++;
      if (writes === 1)
        await new Promise<void>((resolve) => {
          completeFirst = resolve;
        });
      saved = value;
    },
  };
  const source = {
    routeId: 'custom',
    async discover() {
      return [findModel(fallbackModelCatalog('custom'), `future-${++calls}`)];
    },
  };
  const discovery = createModelDiscovery({ cache, timeoutMs: 5 });
  expect((await discovery.refresh(source)).state).toBe('unavailable');
  expect((await discovery.refresh(source)).state).toBe('unavailable');
  expect(writes).toBe(1);
  completeFirst?.();
  await Promise.resolve();
  expect((await discovery.refresh(source)).state).toBe('current');
  expect(saved?.models[0]?.id).toBe('future-3');
});
