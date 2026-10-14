/** SOV-owned disk adapter. SDK discovery remains portable and disk-free. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import type { Settings } from '@yevgetman/sov-sdk/config/schema';
import {
  type ModelCatalog,
  type ModelCatalogCache,
  type ModelDiscoverySource,
  type ModelRecord,
  createDirectModelSource,
  createModelDiscovery,
  createOpenRouterModelSource,
  createSubscriptionModelSource,
  findModel,
} from '@yevgetman/sov-sdk/providers/models/index';
import { fallbackModelCatalog } from '@yevgetman/sov-sdk/providers/models/index';
import {
  assertSubscriptionDiskCatalog,
  presentSubscriptionCatalog,
  reportSubscriptionPin,
  subscriptionDiskRoute,
  subscriptionPinNotice,
  withSelectableSubscriptionEfforts,
} from '@yevgetman/sov-sdk/providers/models/subscriptionCatalog';
import { validateModelCatalog } from '@yevgetman/sov-sdk/providers/models/validate';
import {
  type RouteRecord,
  effortsForModel,
  getRoute,
} from '@yevgetman/sov-sdk/providers/routes/index';

import { readOwnerGrokRegistry } from './ownerModelRegistry.js';

function subscriptionCacheId(key: string): boolean {
  return key.startsWith('chatgpt-subscription:') || key.startsWith('grok-subscription:');
}

/** API-key catalogs stay flat. Subscription catalogs are per route under this root. */
export function modelCatalogCacheFile(root: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex');
  const route = subscriptionDiskRoute(key);
  if (route) return join(root, 'subscription', route, `${digest}.json`);
  return join(root, `${digest}.json`);
}

const CATALOG_FILE_LIMIT = 16 * 1024 * 1024;

function readCatalogIdentity(
  file: string,
): { dev: number; ino: number; text: string; parsed: unknown } | undefined {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > CATALOG_FILE_LIMIT) return undefined;
    const text = readFileSync(file, 'utf8');
    return { dev: info.dev, ino: info.ino, text, parsed: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function sameCatalogPayload(parsed: unknown, expected: ModelCatalog): boolean {
  const validated = validateModelCatalog(parsed, expected.routeId, Number.MAX_SAFE_INTEGER);
  // Same canonical payload as modelCatalogIdentity. fetchedAt and ids are not enough.
  return JSON.stringify(validated ?? null) === JSON.stringify(expected);
}

export function diskModelCache(
  root = join(resolveHarnessHome(), 'model-catalog'),
): ModelCatalogCache {
  return {
    async get(key) {
      if (subscriptionCacheId(key) && !subscriptionDiskRoute(key)) return undefined;
      const stored = readCatalogIdentity(modelCatalogCacheFile(root, key));
      return stored ? (stored.parsed as ModelCatalog) : undefined;
    },
    async set(key, catalog, expected) {
      assertSubscriptionDiskCatalog(key, catalog);
      const file = modelCatalogCacheFile(root, key);
      // Failure writes are conditional. Check inode and payload in this same
      // section as rename, so a removed route directory is not recreated.
      if (expected) {
        const seen = readCatalogIdentity(file);
        if (!seen || !sameCatalogPayload(seen.parsed, expected)) return;
        mkdirSync(root, { recursive: true, mode: 0o700 });
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          const again = readCatalogIdentity(file);
          if (
            !again ||
            again.dev !== seen.dev ||
            again.ino !== seen.ino ||
            again.text !== seen.text
          )
            return;
          writeFileSync(tmp, JSON.stringify(catalog), { mode: 0o600 });
          const ready = readCatalogIdentity(file);
          if (
            !ready ||
            ready.dev !== seen.dev ||
            ready.ino !== seen.ino ||
            ready.text !== seen.text
          )
            return;
          renameSync(tmp, file);
        } finally {
          rmSync(tmp, { force: true });
        }
        return;
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(catalog), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

/**
 * Delete one owner's subscription catalog for a route. The cache key is
 * `${service}:${identity}` (default `SOV_SUB_CHATGPT:SOV_SUB_CHATGPT` or
 * `SOV_SUB_GROK:SOV_SUB_GROK`). The disk id is the route id plus that string.
 * An account change under that same service name must clear the whole route
 * directory. Does not read credential bytes or API-key caches.
 */
export function clearSubscriptionCatalogCache(
  root: string,
  routeId: 'chatgpt-subscription' | 'grok-subscription',
): void {
  rmSync(join(root, 'subscription', routeId), { recursive: true, force: true });
}

export function resetSubscriptionCatalogForProvider(
  name: 'chatgpt' | 'grok',
  harnessHome = resolveHarnessHome(),
): void {
  clearSubscriptionCatalogCache(
    join(harnessHome, 'model-catalog'),
    name === 'chatgpt' ? 'chatgpt-subscription' : 'grok-subscription',
  );
}

/** Host hook for login and logout. Provider name only; no credential bytes. */
export function subscriptionSessionHooks(harnessHome = resolveHarnessHome()): {
  onIdentityChanged: (name: 'chatgpt' | 'grok') => void;
} {
  return {
    onIdentityChanged: (name) => resetSubscriptionCatalogForProvider(name, harnessHome),
  };
}

/** Official public evidence cannot authorize a different compatible endpoint. */
function isOfficialOpenRouterEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://openrouter.ai' &&
      /^\/api\/v1\/*$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
}

export function modelSource(
  routeId: string,
  settings: Settings = {},
  env = process.env,
): ModelDiscoverySource {
  const route = getRoute(routeId, settings);
  if (route.provider === 'openrouter') {
    const baseUrl = settings.providers?.openrouter?.baseUrl;
    if (baseUrl !== undefined && !isOfficialOpenRouterEndpoint(baseUrl)) {
      return {
        routeId,
        cacheKey: `endpoint-${createHash('sha256').update(baseUrl).digest('hex')}`,
        async discover() {
          throw new Error('Custom endpoint discovery unavailable');
        },
      };
    }
    return createOpenRouterModelSource();
  }
  if (route.auth === 'subscription')
    return createSubscriptionModelSource(routeId as 'chatgpt-subscription' | 'grok-subscription');
  const provider = route.provider as 'anthropic' | 'openai' | 'xai';
  const config = settings.providers?.[provider];
  // The runtime can select any usable pool slot (priority, rotation or cooldown).
  // A first-key catalog must not become evidence for a different account's turn.
  // Discovery stays read-only: no pool selection or persistent credential reads.
  const keys = new Set(
    [
      env[
        { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY' }[provider]
      ],
      config?.apiKey,
      ...(config?.apiKeys ?? []),
      ...(config?.credentials?.map((credential) => credential.apiKey ?? credential.token) ?? []),
    ].filter((key): key is string => Boolean(key)),
  );
  if (keys.size > 1) {
    return {
      routeId,
      cacheKey: 'ambiguous-account-pool',
      async discover() {
        throw new Error('Discovery requires an unambiguous account');
      },
    };
  }
  const apiKey = [...keys][0];
  if (!apiKey || config?.baseUrl) {
    return {
      routeId,
      cacheKey: 'unconfigured',
      async discover() {
        throw new Error('Discovery unavailable');
      },
    };
  }
  return createDirectModelSource({
    provider,
    apiKey,
    accountId: createHash('sha256').update(apiKey).digest('hex'),
  });
}

export async function readModelCatalog(
  routeId: string,
  settings: Settings = {},
  refresh = false,
  cache: ModelCatalogCache = diskModelCache(),
): Promise<ModelCatalog> {
  const owned = routeId === 'grok-subscription' ? readOwnerGrokRegistry() : undefined;
  if (owned)
    return refresh
      ? {
          ...owned,
          state: 'stale',
          error:
            'Owner registry requires explicit re-import; subscription discovery is unavailable.',
          models: owned.models.map((model) => ({
            ...model,
            metadata: { ...model.metadata, stale: true },
          })),
        }
      : owned;
  const source = modelSource(routeId, settings);
  const service = createModelDiscovery({ cache });
  const catalog = refresh ? await service.refresh(source) : await service.read(source);
  return presentSubscriptionCatalog(catalog);
}

export async function selectedModelRecord(
  routeId: string,
  model: string,
  settings: Settings = {},
): Promise<ModelRecord> {
  return findModel(await readModelCatalog(routeId, settings), model);
}

export type ModelQuery = {
  route: string;
  search?: string;
  author?: string;
  offset?: number;
  limit?: number;
  refresh?: boolean;
};
export function modelAuthor(model: ModelRecord): string | undefined {
  return (
    model.author ??
    (model.provider === 'openrouter' && model.id.includes('/') ? model.id.split('/')[0] : undefined)
  );
}

/**
 * Operator JSON keeps the normalized image capability.
 * A subscription transport with no image serializer does not rewrite supported or unknown.
 */
export function subscriptionOperatorModel(model: ModelRecord): ModelRecord {
  return model;
}

function subscriptionRefreshError(catalog: ModelCatalog): string {
  if (catalog.models.some((model) => model.metadata.ownerManaged))
    return 'No subscription catalog endpoint is configured. Re-import owner registry metadata. Saved route/model/effort remain in force.';
  const subscription =
    catalog.routeId === 'chatgpt-subscription' || catalog.routeId === 'grok-subscription';
  if (subscription && catalog.fetchedAt && catalog.state === 'stale') {
    return 'Subscription refresh cannot fetch a catalog. The stored timestamped catalog was left stale and tightened.';
  }
  return 'Model discovery unavailable.';
}

export function modelPage(catalog: ModelCatalog, query: ModelQuery) {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('Invalid pagination');
  if ((query.search?.length ?? 0) > 256 || (query.author?.length ?? 0) > 256)
    throw new Error('Invalid filter');
  const search = query.search?.toLowerCase();
  const viewed = withSelectableSubscriptionEfforts(catalog);
  const models = viewed.models.filter(
    (model) =>
      !model.metadata.retired &&
      (!query.author || modelAuthor(model) === query.author) &&
      (!search || `${model.id} ${model.displayName}`.toLowerCase().includes(search)),
  );
  const ownerManaged = viewed.models.some((model) => model.metadata.ownerManaged);
  const pin = ownerManaged ? undefined : reportSubscriptionPin(viewed);
  return {
    schemaVersion: 1,
    route: catalog.routeId,
    state: catalog.state,
    sessionReset: { transcriptOnly: true, preserves: ['route', 'model', 'effort'] },
    ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}),
    ...(pin
      ? {
          defaultModel: pin.id,
          pinnedDefault: pin,
          error: {
            code:
              pin.status === 'missing' ? 'pinned_default_missing' : 'pinned_default_unavailable',
            message: subscriptionPinNotice(pin),
          },
        }
      : catalog.error
        ? {
            error: {
              code: 'catalog_unavailable',
              message: subscriptionRefreshError(catalog),
            },
          }
        : {}),
    ...(viewed.models.some((model) => model.metadata.ownerManaged)
      ? {
          catalogKind: 'owner-managed',
          retiredModels: viewed.models
            .filter((model) => model.metadata.retired)
            .map((model) => model.id),
          catalogNotice:
            'Owner-managed metadata; re-import to review freshness. Saved route/model/effort remain in force after /new.',
        }
      : {}),
    total: models.length,
    offset,
    limit,
    nextOffset: offset + limit < models.length ? offset + limit : null,
    models: models.slice(offset, offset + limit).map(subscriptionOperatorModel),
  };
}

/** Synchronous menu snapshot; shares the exact disk cache and validation with models CLI. */
export function routeForProvider(provider: string): string | undefined {
  return (
    {
      openrouter: 'openrouter-api',
      anthropic: 'anthropic-api',
      openai: 'openai-api',
      xai: 'grok-api',
      chatgpt: 'chatgpt-subscription',
      grok: 'grok-subscription',
    } as Record<string, string>
  )[provider];
}

export function readModelCatalogSnapshot(
  routeId: string,
  settings: Settings = {},
  harnessHome = resolveHarnessHome(),
): ModelCatalog {
  const owned = routeId === 'grok-subscription' ? readOwnerGrokRegistry(harnessHome) : undefined;
  if (owned) return owned;
  const source = modelSource(routeId, settings);
  const root = join(harnessHome, 'model-catalog');
  const key = `${source.routeId}:${source.cacheKey ?? 'public'}`;
  if (subscriptionCacheId(key) && !subscriptionDiskRoute(key)) return fallbackModelCatalog(routeId);
  const file = modelCatalogCacheFile(root, key);
  try {
    if (statSync(file).size > 16 * 1024 * 1024) return fallbackModelCatalog(routeId);
    const catalog = validateModelCatalog(
      JSON.parse(readFileSync(file, 'utf8')),
      routeId,
      Date.now(),
    );
    if (!catalog) return fallbackModelCatalog(routeId);
    const stale =
      catalog.state !== 'current' ||
      !catalog.fetchedAt ||
      Date.now() - Date.parse(catalog.fetchedAt) >= 3600000;
    const presented = withSelectableSubscriptionEfforts(
      presentSubscriptionCatalog({
        ...catalog,
        state: catalog.state === 'current' && stale ? 'stale' : catalog.state,
        models: catalog.models.map((model) => ({
          ...model,
          metadata: { ...model.metadata, stale: stale || model.metadata.stale },
        })),
      }),
    );
    const pin = reportSubscriptionPin(presented);
    if (!pin) return presented;
    return { ...presented, pinnedDefault: pin, error: subscriptionPinNotice(pin) };
  } catch {
    return fallbackModelCatalog(routeId);
  }
}

/** SOV route diagnostics include explicit owner facts while SDK routes stay disk-free. */
export function routeWithOwnerModels(route: RouteRecord, catalog: ModelCatalog): RouteRecord {
  if (route.id !== 'grok-subscription' || catalog.routeId !== route.id) return route;
  const records = catalog.models.filter((model) => model.metadata.ownerManaged);
  if (!records.length) return route;
  const retired = new Set(
    records.filter((model) => model.metadata.retired).map((model) => model.id),
  );
  const active = records.filter((model) => !model.metadata.retired);
  const models = [...new Set([...route.models, ...active.map((model) => model.id)])].filter(
    (id) => !retired.has(id),
  );
  const updated = {
    ...route,
    catalogState: catalog.state,
    catalogKind: 'owner-managed',
    models,
    modelEfforts: {
      ...Object.fromEntries(Object.entries(route.modelEfforts).filter(([id]) => !retired.has(id))),
      ...Object.fromEntries(
        active.map((model) => [model.id, effortsForModel(route, model.id, model)]),
      ),
    },
  };
  if (retired.has(route.defaultModel))
    return {
      ...updated,
      rejectedConfiguredDefault: route.defaultModel,
      defaultModelNotice: `Owner registry marks saved default ${route.defaultModel} retired. Change the selected model or update the registry; /new preserves saved dials.`,
    };
  if (!active.some((model) => model.id === route.rejectedConfiguredDefault)) return updated;
  const {
    rejectedConfiguredDefault: _rejected,
    defaultModelNotice: _notice,
    ...accepted
  } = updated;
  return accepted;
}
