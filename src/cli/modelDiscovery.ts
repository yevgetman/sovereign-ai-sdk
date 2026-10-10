/** SOV-owned disk adapter. SDK discovery remains portable and disk-free. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { validateModelCatalog } from '@yevgetman/sov-sdk/providers/models/validate';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';

export function diskModelCache(
  root = join(resolveHarnessHome(), 'model-catalog'),
): ModelCatalogCache {
  const path = (key: string) =>
    join(root, `${createHash('sha256').update(key).digest('hex')}.json`);
  return {
    async get(key) {
      try {
        const file = path(key);
        if (statSync(file).size > 16 * 1024 * 1024) return undefined;
        return JSON.parse(readFileSync(file, 'utf8')) as ModelCatalog;
      } catch {
        return undefined;
      }
    },
    async set(key, catalog) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const file = path(key);
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(catalog), { mode: 0o600 });
      renameSync(tmp, file);
    },
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
  const apiKey =
    env[
      { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY' }[provider]
    ] ||
    config?.apiKey ||
    config?.apiKeys?.find(Boolean) ||
    config?.credentials?.find((credential) => credential.apiKey || credential.token)?.apiKey ||
    config?.credentials?.find((credential) => credential.apiKey || credential.token)?.token;
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
  return refresh ? service.refresh(source) : service.read(source);
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
  const models = catalog.models.filter(
    (model) =>
      (!query.author || modelAuthor(model) === query.author) &&
      (!search || `${model.id} ${model.displayName}`.toLowerCase().includes(search)),
  );
  return {
    schemaVersion: 1,
    route: catalog.routeId,
    state: catalog.state,
    ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}),
    ...(catalog.error
      ? { error: { code: 'catalog_unavailable', message: 'Model discovery unavailable.' } }
      : {}),
    total: models.length,
    offset,
    limit,
    nextOffset: offset + limit < models.length ? offset + limit : null,
    models: models.slice(offset, offset + limit),
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
  const file = join(root, `${createHash('sha256').update(key).digest('hex')}.json`);
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
    return {
      ...catalog,
      state: catalog.state === 'current' && stale ? 'stale' : catalog.state,
      models: catalog.models.map((model) => ({
        ...model,
        metadata: { ...model.metadata, stale: stale || model.metadata.stale },
      })),
    };
  } catch {
    return fallbackModelCatalog(routeId);
  }
}
