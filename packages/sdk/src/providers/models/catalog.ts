import { listRoutes } from '../routes/catalog.js';
import type {
  ModelCatalog,
  ModelCatalogCache,
  ModelDiscoveryOptions,
  ModelDiscoverySource,
  ModelRecord,
} from './types.js';
import { validateModelCatalog, validateModelRecords } from './validate.js';

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
  return { version: 1, routeId, models, state: 'unavailable' };
}

export function createMemoryModelCatalogCache(): ModelCatalogCache {
  const values = new Map<string, ModelCatalog>();
  return {
    async get(key) {
      const value = values.get(key);
      return value ? structuredClone(value) : undefined;
    },
    async set(key, value) {
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
  async function persist(key: string, catalog: ModelCatalog): Promise<void> {
    // Serialize even ports that ignore timeout: a late old write cannot overwrite
    // a later successful refresh. A stuck port never starts additional writes.
    const prior = writes.get(key);
    if (prior) await bounded(() => prior);
    const write = Promise.resolve().then(() => cache.set(key, structuredClone(catalog)));
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
  async function read(source: ModelDiscoverySource): Promise<ModelCatalog> {
    let saved: ModelCatalog | undefined;
    try {
      saved =
        (failedSnapshots.has(keyFor(source))
          ? structuredClone(failedSnapshots.get(keyFor(source)))
          : undefined) ??
        validateModelCatalog(await bounded(() => cache.get(keyFor(source))), source.routeId, now());
    } catch {
      /* corrupt/unavailable cache is an offline fallback */
    }
    if (!saved || saved.version !== 1 || saved.routeId !== source.routeId)
      return fallbackModelCatalog(source.routeId);
    const stale =
      saved.state !== 'current' ||
      !saved.fetchedAt ||
      now() - Date.parse(saved.fetchedAt) >= ttl ||
      !Number.isFinite(Date.parse(saved.fetchedAt));
    return {
      ...saved,
      state: saved.state === 'current' && stale ? 'stale' : saved.state,
      models: saved.models.map((model) => ({
        ...model,
        metadata: { ...model.metadata, stale: stale || model.metadata.stale },
      })),
    };
  }
  async function refresh(source: ModelDiscoverySource): Promise<ModelCatalog> {
    const key = keyFor(source);
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = (async (): Promise<ModelCatalog> => {
      const controller = new AbortController();
      const previous = await read(source);
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
        const catalog: ModelCatalog = {
          version: 1,
          routeId: source.routeId,
          state: 'current',
          fetchedAt,
          models: models.map((model) => ({
            ...model,
            metadata: { ...model.metadata, fetchedAt, stale: false },
          })),
        };
        await persist(key, catalog);
        failedSnapshots.delete(key);
        return structuredClone(catalog);
      } catch {
        const failed: ModelCatalog = {
          ...previous,
          state: previous.fetchedAt ? 'stale' : 'unavailable',
          error: 'Model discovery unavailable',
          models: previous.models.map((model) => ({
            ...model,
            metadata: { ...model.metadata, stale: true },
          })),
        };
        failedSnapshots.set(key, structuredClone(failed));
        try {
          await persist(key, failed);
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
