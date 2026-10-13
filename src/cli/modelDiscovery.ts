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
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';

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

export function diskModelCache(
  root = join(resolveHarnessHome(), 'model-catalog'),
): ModelCatalogCache {
  return {
    async get(key) {
      if (subscriptionCacheId(key) && !subscriptionDiskRoute(key)) return undefined;
      try {
        const file = modelCatalogCacheFile(root, key);
        if (statSync(file).size > 16 * 1024 * 1024) return undefined;
        return JSON.parse(readFileSync(file, 'utf8')) as ModelCatalog;
      } catch {
        return undefined;
      }
    },
    async set(key, catalog) {
      assertSubscriptionDiskCatalog(key, catalog);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const file = modelCatalogCacheFile(root, key);
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
      (!query.author || modelAuthor(model) === query.author) &&
      (!search || `${model.id} ${model.displayName}`.toLowerCase().includes(search)),
  );
  const pin = reportSubscriptionPin(viewed);
  return {
    schemaVersion: 1,
    route: catalog.routeId,
    state: catalog.state,
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
