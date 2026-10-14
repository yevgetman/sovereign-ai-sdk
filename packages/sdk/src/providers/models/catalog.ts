import { listRoutes } from '../routes/catalog.js';
import {
  applyGrokSubscriptionPins,
  grokSubscriptionPin,
  isGrokSubscriptionModelId,
} from './grokPin.js';
import { effectiveSubscriptionImageModel } from './imageInput.js';
import { presentSubscriptionCatalog } from './subscriptionCatalog.js';
import type {
  ModelCatalog,
  ModelCatalogCache,
  ModelDiscoveryOptions,
  ModelDiscoverySource,
  ModelRecord,
} from './types.js';
import { validateModelCatalog, validateModelRecords } from './validate.js';

/** Full canonical payload. fetchedAt and model ids alone do not identify an entry. */
function modelCatalogIdentity(catalog: ModelCatalog | undefined): string {
  if (!catalog) return '';
  return JSON.stringify(catalog);
}

/** Offline suggestions only; no credential reads, provider creation or network. */
export function fallbackModelCatalog(routeId: string): ModelCatalog {
  const route = listRoutes().find((candidate) => candidate.id === routeId);
  const models: ModelRecord[] =
    route?.models.map((id) => ({
      id,
      displayName: id,
      routeId,
      provider: route.provider,
      auth: route.auth,
      capabilities: {
        textOutput: 'unknown',
        tools: 'unknown',
        images: 'unknown',
        reasoning: 'unknown',
      },
      availability: 'unknown',
      metadata: { source: 'bundled-suggestions', stale: true },
    })) ?? [];
  return applyGrokSubscriptionPins({ version: 1, routeId, models, state: 'unavailable' });
}

export function createMemoryModelCatalogCache(): ModelCatalogCache {
  const values = new Map<string, ModelCatalog>();
  return {
    async get(key) {
      const value = values.get(key);
      return value ? structuredClone(value) : undefined;
    },
    async set(key, value, expected) {
      if (expected) {
        const validated = validateModelCatalog(
          values.get(key),
          expected.routeId,
          Number.MAX_SAFE_INTEGER,
        );
        // Same exclusive section as the insert: a removed entry stays removed.
        if (modelCatalogIdentity(validated) !== modelCatalogIdentity(expected)) return;
      }
      values.set(key, structuredClone(value));
    },
  };
}

/** Reads are offline. Only refresh invokes the injected discovery source. */
export function createModelDiscovery(options: ModelDiscoveryOptions = {}) {
  const cache = options.cache ?? createMemoryModelCatalogCache();
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 3_600_000;
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(ttl) || ttl < 0 || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Model discovery TTL must be nonnegative and timeout positive');
  }
  const pending = new Map<string, Promise<ModelCatalog>>();
  // A failed write cannot make this instance trust a still-current external cache.
  const failedSnapshots = new Map<string, ModelCatalog>();
  const writes = new Map<string, Promise<void>>();
  async function bounded<T>(operation: () => Promise<T>, abort?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort?.();
            reject(new Error('Model discovery operation timed out'));
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function persist(
    key: string,
    catalog: ModelCatalog,
    expected?: ModelCatalog,
  ): Promise<void> {
    // Serialize even ports that ignore timeout: a late old write cannot overwrite
    // a later successful refresh. A stuck port never starts additional writes.
    const prior = writes.get(key);
    if (prior) await bounded(() => prior);
    const write = (async () => {
      const payload = structuredClone(catalog);
      if (!expected) {
        // The promise must stay pending if set ignores the timeout, so a later
        // refresh cannot start a second write over the late one.
        await cache.set(key, payload);
        return;
      }
      let current: ModelCatalog | undefined;
      try {
        current = validateModelCatalog(await cache.get(key), catalog.routeId, now()) ?? undefined;
      } catch {
        current = undefined;
      }
      // Re-check inside this write. fetchedAt plus ids is not the stored entry.
      if (modelCatalogIdentity(current) !== modelCatalogIdentity(expected)) return;
      await cache.set(key, payload, structuredClone(expected));
    })();
    writes.set(key, write);
    void write.then(
      () => {
        if (writes.get(key) === write) writes.delete(key);
      },
      () => {
        if (writes.get(key) === write) writes.delete(key);
      },
    );
    await bounded(() => write);
  }
  const keyFor = (source: ModelDiscoverySource) =>
    `${source.routeId}:${source.cacheKey ?? 'public'}`;
  async function cacheEntry(source: ModelDiscoverySource): Promise<ModelCatalog | undefined> {
    try {
      return (
        validateModelCatalog(
          await bounded(() => cache.get(keyFor(source))),
          source.routeId,
          now(),
        ) ?? undefined
      );
    } catch {
      return undefined;
    }
  }
  function view(saved: ModelCatalog | undefined, source: ModelDiscoverySource): ModelCatalog {
    if (!saved || saved.version !== 1 || saved.routeId !== source.routeId)
      return fallbackModelCatalog(source.routeId);
    const stale =
      saved.state !== 'current' ||
      !saved.fetchedAt ||
      now() - Date.parse(saved.fetchedAt) >= ttl ||
      !Number.isFinite(Date.parse(saved.fetchedAt));
    return applyGrokSubscriptionPins(
      presentSubscriptionCatalog({
        ...saved,
        state: saved.state === 'current' && stale ? 'stale' : saved.state,
        models: saved.models.map((model) => ({
          ...model,
          metadata: { ...model.metadata, stale: stale || model.metadata.stale },
        })),
      }),
    );
  }
  async function read(source: ModelDiscoverySource): Promise<ModelCatalog> {
    const remembered = failedSnapshots.get(keyFor(source));
    return view(remembered ? structuredClone(remembered) : await cacheEntry(source), source);
  }
  async function refresh(source: ModelDiscoverySource): Promise<ModelCatalog> {
    const key = keyFor(source);
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = (async (): Promise<ModelCatalog> => {
      const controller = new AbortController();
      const remembered = failedSnapshots.get(key);
      const observed = remembered ? structuredClone(remembered) : await cacheEntry(source);
      const previous = view(observed, source);
      try {
        const rawModels = await bounded(
          () =>
            source.discover({
              fetch: options.fetch ?? globalThis.fetch,
              signal: controller.signal,
            }),
          () => controller.abort(),
        );
        const models = validateModelRecords(rawModels, source.routeId, now());
        if (!models) throw new Error('Invalid discovery metadata');
        const fetchedAt = new Date(now()).toISOString();
        const catalog: ModelCatalog = applyGrokSubscriptionPins({
          version: 1,
          routeId: source.routeId,
          state: 'current',
          fetchedAt,
          models: models.map((model) => ({
            ...model,
            metadata: { ...model.metadata, fetchedAt, stale: false },
          })),
        });
        await persist(key, catalog);
        failedSnapshots.delete(key);
        return structuredClone(catalog);
      } catch {
        // Account rows tighten before the publisher pin is put back. Disk still
        // rejects a stale account row that expands tools or effort.
        const failed = applyGrokSubscriptionPins(
          presentSubscriptionCatalog({
            ...previous,
            state: previous.fetchedAt ? 'stale' : 'unavailable',
            error: 'Model discovery unavailable',
            models: previous.models.map((model) => ({
              ...model,
              metadata: { ...model.metadata, stale: true },
            })),
          }),
        );
        failedSnapshots.set(key, structuredClone(failed));
        try {
          // Login can rmSync the route directory after the read. Do not write
          // that account back. An empty cache on both reads was never stored.
          if (observed) await persist(key, failed, observed);
          else if (!(await cacheEntry(source))) await persist(key, failed);
        } catch {
          /* in-memory invalidation remains */
        }
        return structuredClone(failed);
      }
    })();
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      pending.delete(key);
    }
  }
  return { read, refresh };
}

/** Retains caller-entered IDs even when discovery is absent or a model was delisted. */
export function findModel(catalog: ModelCatalog, id: string): ModelRecord {
  const owned = catalog.models.find((model) => model.id === id && model.metadata.ownerManaged);
  if (owned) return effectiveSubscriptionImageModel(structuredClone(owned));
  if (catalog.routeId === 'grok-subscription' && isGrokSubscriptionModelId(id)) {
    return grokSubscriptionPin(id);
  }
  const existing = catalog.models.find((model) => model.id === id);
  if (existing) return structuredClone(existing);
  const route = listRoutes().find((candidate) => candidate.id === catalog.routeId);
  return {
    id,
    displayName: id,
    routeId: catalog.routeId,
    provider: route?.provider ?? 'custom',
    auth: route?.auth ?? 'custom',
    capabilities: {
      textOutput: 'unknown',
      tools: 'unknown',
      images: 'unknown',
      reasoning: 'unknown',
    },
    availability: 'unknown',
    metadata: { source: 'caller', stale: false },
  };
}
