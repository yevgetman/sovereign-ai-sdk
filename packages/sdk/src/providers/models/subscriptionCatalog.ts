// Pure subscription catalog policy. No endpoint is named and nothing here fetches.
import { REASONING_EFFORTS, type ReasoningEffort } from '../effort.js';
import { SUBSCRIPTION_ROUTE_EFFORTS } from '../routes/catalog.js';
import { KEYCHAIN_SERVICE, SUBSCRIPTION_DEFAULT_MODEL } from '../subscription/names.js';
import { fallbackModelCatalog } from './catalog.js';
import { object, positiveNumber } from './http.js';
import type { CapabilitySupport, ModelCatalog, ModelRecord } from './types.js';

export const SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE = 'subscription-account-catalog';

export type SubscriptionCatalogRoute = 'chatgpt-subscription' | 'grok-subscription';

const TOKEN_MATERIAL = /authorization|bearer|\bsk-|access_token|refresh_token/i;

export type AppliedSubscriptionCatalog = {
  routeId: SubscriptionCatalogRoute;
  /** Built-in pin. A payload never replaces it. */
  defaultModel: string;
  state: 'current' | 'unavailable';
  models: ModelRecord[];
  /** True when a current account list did not contain the pin. */
  missingPinnedDefault: boolean;
  /** True when the pin was seen and no kept model has that id. */
  pinnedDefaultUnavailable: boolean;
  /** False for 401, 403, empty, and every non-current result. */
  cacheableCurrent: boolean;
  listedAt?: string | undefined;
};

export function subscriptionPinnedDefault(routeId: SubscriptionCatalogRoute): string {
  return routeId === 'chatgpt-subscription'
    ? SUBSCRIPTION_DEFAULT_MODEL.chatgpt
    : SUBSCRIPTION_DEFAULT_MODEL.grok;
}

/** Non-secret cache scope tied to the Keychain service name. Never a token or `public`. */
export function subscriptionAccountCacheKey(
  routeId: SubscriptionCatalogRoute,
  accountKey?: string,
): string {
  const service =
    routeId === 'grok-subscription' ? KEYCHAIN_SERVICE.grok : KEYCHAIN_SERVICE.chatgpt;
  const identity = (accountKey ?? service).trim();
  if (
    identity === 'public' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(identity) ||
    TOKEN_MATERIAL.test(identity)
  ) {
    throw new Error('Subscription cache key must be a non-secret account identity');
  }
  return `${service}:${identity}`;
}

export function subscriptionDiskRoute(cacheId: string): SubscriptionCatalogRoute | undefined {
  if (cacheId.startsWith(`chatgpt-subscription:${KEYCHAIN_SERVICE.chatgpt}:`))
    return 'chatgpt-subscription';
  if (cacheId.startsWith(`grok-subscription:${KEYCHAIN_SERVICE.grok}:`)) return 'grok-subscription';
  return undefined;
}

export function containsCredentialMaterial(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' && TOKEN_MATERIAL.test(text);
  } catch {
    return true;
  }
}

function support(value: unknown): CapabilitySupport {
  const supported = typeof value === 'boolean' ? value : object(value).supported;
  return supported === true ? 'supported' : supported === false ? 'unsupported' : 'unknown';
}

function cleanLabel(value: string): string | undefined {
  if (value.length === 0 || value.length > 200 || TOKEN_MATERIAL.test(value)) return undefined;
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return undefined;
  return value;
}

function listedAt(value: string | undefined): string | undefined {
  if (!value || TOKEN_MATERIAL.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > Date.now()) return undefined;
  return value;
}

function nonText(row: Record<string, unknown>): boolean {
  return Array.isArray(row.output_modalities) && !row.output_modalities.includes('text');
}

/**
 * Publisher fields on this row only. Does not read another model's tools, efforts,
 * images, context, pricing, or API-key availability.
 */
export function normalizeSubscriptionCatalogRow(
  value: unknown,
  routeId: SubscriptionCatalogRoute,
  options: { accountCatalog?: boolean; listedAt?: string } = {},
): ModelRecord | undefined {
  const row = object(value);
  if (typeof row.id !== 'string') return undefined;
  const id = cleanLabel(row.id.trim());
  if (!id) return undefined;
  if (row.lifecycle === 'retired' || nonText(row)) return undefined;
  const capability = object(row.capabilities);
  const input = Array.isArray(row.input_modalities) ? row.input_modalities : undefined;
  const output = Array.isArray(row.output_modalities) ? row.output_modalities : undefined;
  const rawEfforts = Array.isArray(capability.reasoning_effort)
    ? capability.reasoning_effort
    : undefined;
  const genericEfforts = rawEfforts?.flatMap((entry) =>
    entry === 'xhigh'
      ? ['max' as const]
      : REASONING_EFFORTS.includes(entry as ReasoningEffort)
        ? [entry as ReasoningEffort]
        : [],
  );
  const published = genericEfforts ?? [];
  const efforts: ReasoningEffort[] | undefined = published.length
    ? REASONING_EFFORTS.filter((level) => level === 'off' || published.includes(level))
    : undefined;
  const observed = listedAt(options.listedAt);
  const displayName =
    typeof row.display_name === 'string' ? cleanLabel(row.display_name) : undefined;
  return {
    id,
    displayName: displayName ?? id,
    routeId,
    provider: routeId === 'chatgpt-subscription' ? 'chatgpt' : 'grok',
    auth: 'subscription',
    capabilities: {
      textOutput: output?.includes('text') ? 'supported' : support(capability.text_output),
      tools: support(capability.tools),
      images: input
        ? input.includes('image')
          ? 'supported'
          : 'unsupported'
        : support(capability.image_input ?? capability.images),
      reasoning: rawEfforts
        ? rawEfforts.length
          ? efforts?.length
            ? 'supported'
            : 'unknown'
          : 'unsupported'
        : support(capability.thinking ?? capability.reasoning),
    },
    contextWindow: positiveNumber(row.max_input_tokens ?? row.context_window ?? row.context_length),
    maxOutputTokens: positiveNumber(row.max_tokens ?? row.max_output_tokens),
    ...(efforts ? { efforts } : {}),
    availability: options.accountCatalog ? 'account' : 'unknown',
    metadata: {
      source: SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE,
      stale: false,
      ...(observed ? { fetchedAt: observed } : {}),
    },
  };
}

function rowsOf(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return undefined;
  const row = object(body);
  const data = row.data ?? row.models;
  return Array.isArray(data) ? data : undefined;
}

function unavailable(routeId: SubscriptionCatalogRoute): AppliedSubscriptionCatalog {
  return {
    routeId,
    defaultModel: subscriptionPinnedDefault(routeId),
    state: 'unavailable',
    models: fallbackModelCatalog(routeId).models,
    missingPinnedDefault: false,
    pinnedDefaultUnavailable: false,
    cacheableCurrent: false,
  };
}

/** Apply a payload the caller already holds. Does not fetch, log, or move the pin. */
export function applySubscriptionAccountCatalog(
  routeId: SubscriptionCatalogRoute,
  input: { status?: number; body?: unknown; listedAt?: string } = {},
): AppliedSubscriptionCatalog {
  if (input.status === 401 || input.status === 403) return unavailable(routeId);
  if (input.status !== undefined && input.status !== 200) return unavailable(routeId);
  const rows = rowsOf(input.body);
  if (!rows?.length) return unavailable(routeId);
  const pin = subscriptionPinnedDefault(routeId);
  const models: ModelRecord[] = [];
  const seen = new Set<string>();
  let pinSeen = false;
  for (const row of rows) {
    const raw = object(row);
    if (raw.id === pin) pinSeen = true;
    const model = normalizeSubscriptionCatalogRow(row, routeId, {
      accountCatalog: true,
      ...(input.listedAt ? { listedAt: input.listedAt } : {}),
    });
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  const pinUnavailable = pinSeen && !models.some((model) => model.id === pin);
  if (!models.length || containsCredentialMaterial(models)) {
    const fallback = unavailable(routeId);
    if (!pinUnavailable) return fallback;
    // The fallback list is the pin itself. Do not put that retired id back.
    return {
      ...fallback,
      models: fallback.models.filter((model) => model.id !== pin),
      pinnedDefaultUnavailable: true,
    };
  }
  const observed = listedAt(input.listedAt);
  return {
    routeId,
    defaultModel: pin,
    state: 'current',
    models,
    missingPinnedDefault: !pinSeen,
    pinnedDefaultUnavailable: pinUnavailable,
    cacheableCurrent: true,
    ...(observed ? { listedAt: observed } : {}),
  };
}

/** ModelCatalog for a payload the caller already applied. Keeps the pin status. */
export function subscriptionAccountModelCatalog(applied: AppliedSubscriptionCatalog): ModelCatalog {
  const status = applied.pinnedDefaultUnavailable
    ? 'unavailable'
    : applied.state === 'current' && applied.missingPinnedDefault
      ? 'missing'
      : undefined;
  return {
    version: 1,
    routeId: applied.routeId,
    state: applied.state,
    models: applied.models,
    ...(applied.listedAt ? { fetchedAt: applied.listedAt } : {}),
    ...(status ? { pinnedDefault: { id: applied.defaultModel, status } } : {}),
  };
}

/** Missing pin on a current catalog, or an unavailable pin unless that current list still has the id. */
export function reportSubscriptionPin(
  catalog: ModelCatalog,
): { id: string; status: 'missing' | 'unavailable' } | undefined {
  if (catalog.routeId !== 'chatgpt-subscription' && catalog.routeId !== 'grok-subscription')
    return undefined;
  const id = subscriptionPinnedDefault(catalog.routeId);
  const present = catalog.models.some((model) => model.id === id);
  if (
    catalog.pinnedDefault?.id === id &&
    catalog.pinnedDefault.status === 'unavailable' &&
    !(catalog.state === 'current' && present)
  )
    return { id, status: 'unavailable' };
  if (catalog.state !== 'current') return undefined;
  if (present) return undefined;
  return { id, status: 'missing' };
}

export function subscriptionPinNotice(pin: {
  id: string;
  status: 'missing' | 'unavailable';
}): string {
  return pin.status === 'missing'
    ? `Pinned default ${pin.id} is missing from the account list and remains the default.`
    : `Pinned default ${pin.id} is unavailable and remains the default.`;
}

/**
 * Payload efforts are selectable only when this transport already honors them.
 * Both routes use `SUBSCRIPTION_ROUTE_EFFORTS`. An all-`off` transport stays `off`
 * (Grok today). ChatGPT never invents `off`: Codex rejects it. A non-stale pin
 * with no published efforts keeps the ChatGPT transport list. Stale rows keep
 * only the intersection still published, or no levels after those were cleared.
 * A non-pin with no usable published efforts returns no levels. A later
 * Grok-constant change should keep this function.
 */
export function selectableSubscriptionEfforts(record: ModelRecord): ReasoningEffort[] {
  if (record.routeId !== 'grok-subscription' && record.routeId !== 'chatgpt-subscription') {
    return ['off'];
  }
  const transport =
    record.routeId === 'grok-subscription'
      ? SUBSCRIPTION_ROUTE_EFFORTS.grok
      : SUBSCRIPTION_ROUTE_EFFORTS.chatgpt;
  if (transport.length > 0 && transport.every((level) => level === 'off')) return [...transport];
  const published = transport.filter((level) => record.efforts?.includes(level));
  if (record.metadata.stale) return published;
  if (
    record.id === subscriptionPinnedDefault(record.routeId) &&
    (record.metadata.source !== SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE || !record.efforts?.length)
  ) {
    return [...transport];
  }
  if (record.metadata.source !== SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE) return [];
  return published;
}

/** Operator copy. Published levels stay on the normalized record. */
export function withSelectableSubscriptionEfforts(catalog: ModelCatalog): ModelCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      if (model.metadata.source !== SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE) return model;
      // Empty stays [] so operator copy says none. Do not write this view to disk.
      return { ...model, efforts: selectableSubscriptionEfforts(model) };
    }),
  };
}

export function subscriptionToolsSelectable(
  record: ModelRecord,
  state: ModelCatalog['state'],
): boolean {
  return (
    state === 'current' &&
    record.metadata.stale !== true &&
    record.metadata.source === SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE &&
    record.auth === 'subscription' &&
    record.capabilities.textOutput !== 'unsupported' &&
    record.capabilities.tools === 'supported'
  );
}

function tighten(record: ModelRecord): ModelRecord {
  return {
    ...record,
    capabilities: {
      textOutput: record.capabilities.textOutput === 'unsupported' ? 'unsupported' : 'unknown',
      tools: 'unknown',
      images: 'unknown',
      reasoning: 'unknown',
    },
    contextWindow: undefined,
    maxOutputTokens: undefined,
    efforts: undefined,
    pricing: undefined,
    reasoningControl: undefined,
    availability: 'unknown',
    metadata: { ...record.metadata, stale: true },
  };
}

/** Stale or non-current subscription rows cannot expand tools, effort, or context. */
export function presentSubscriptionCatalog(catalog: ModelCatalog): ModelCatalog {
  if (catalog.routeId !== 'chatgpt-subscription' && catalog.routeId !== 'grok-subscription')
    return catalog;
  const current = catalog.state === 'current';
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      if (model.metadata.source !== SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE) return model;
      if (current && !model.metadata.stale) return model;
      return tighten(model);
    }),
  };
}

/** Disk guard. API-key cache ids are ignored. Rejected writes must not include credential text. */
export function assertSubscriptionDiskCatalog(cacheId: string, catalog: ModelCatalog): void {
  const gated =
    cacheId.startsWith('chatgpt-subscription:') || cacheId.startsWith('grok-subscription:');
  if (!gated) return;
  const route = subscriptionDiskRoute(cacheId);
  if (!route || catalog.routeId !== route || catalog.version !== 1)
    throw new Error('Subscription catalog cache requires a non-secret account identity');
  if (containsCredentialMaterial(catalog))
    throw new Error('Subscription catalog cache cannot store credentials');
  if (catalog.state === 'current') {
    if (!catalog.models.length) throw new Error('Empty subscription catalog is not current');
    for (const model of catalog.models) {
      if (
        model.auth !== 'subscription' ||
        model.routeId !== route ||
        model.metadata.source !== SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE ||
        model.availability !== 'account' ||
        model.pricing ||
        model.reasoningControl
      )
        throw new Error('Invalid subscription catalog cache');
    }
    return;
  }
  for (const model of catalog.models) {
    if (
      model.capabilities.tools === 'supported' ||
      model.capabilities.images === 'supported' ||
      model.capabilities.reasoning === 'supported' ||
      model.contextWindow !== undefined ||
      model.maxOutputTokens !== undefined ||
      model.pricing ||
      model.reasoningControl ||
      model.availability === 'account' ||
      model.efforts?.some((level) => level !== 'off')
    )
      throw new Error('Negative subscription cache cannot expand capabilities');
  }
}
