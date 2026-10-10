import { REASONING_EFFORTS } from '../effort.js';
import { listRoutes } from '../routes/catalog.js';
import { fetchModelPages, object, positiveNumber } from './http.js';
import type { ModelDiscoverySource, ModelRecord } from './types.js';

export type DirectModelProvider = 'anthropic' | 'openai' | 'xai';
const ENDPOINTS: Record<DirectModelProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/models',
  openai: 'https://api.openai.com/v1/models',
  xai: 'https://api.x.ai/v1/language-models',
};
export interface DirectModelSourceOptions {
  provider: DirectModelProvider;
  /** Explicit caller-authorized credentials only. Never discovered from environment or disk. */
  apiKey: string;
  /** Required non-secret account scope; isolates the cache from other credentials. */
  accountId: string;
  aliases?: Record<string, string>;
}
/** Missing metadata remains unknown, even if the model name looks familiar. */
export function normalizeDirectModel(
  value: unknown,
  provider: DirectModelProvider,
): ModelRecord | undefined {
  const row = object(value);
  if (typeof row.id !== 'string' || !row.id.trim()) return undefined;
  const capability = object(row.capabilities);
  const support = (value: unknown) => {
    const supported = typeof value === 'boolean' ? value : object(value).supported;
    return supported === true
      ? ('supported' as const)
      : supported === false
        ? ('unsupported' as const)
        : ('unknown' as const);
  };
  const input = Array.isArray(row.input_modalities) ? row.input_modalities : undefined;
  const output = Array.isArray(row.output_modalities) ? row.output_modalities : undefined;
  if (row.lifecycle === 'retired' || (output && !output.includes('text'))) return undefined;
  const rawEfforts = Array.isArray(capability.reasoning_effort)
    ? capability.reasoning_effort
    : undefined;
  const efforts = rawEfforts?.flatMap((value) =>
    value === 'xhigh'
      ? ['max' as const]
      : REASONING_EFFORTS.includes(value as (typeof REASONING_EFFORTS)[number])
        ? [value as (typeof REASONING_EFFORTS)[number]]
        : [],
  );
  const routeId = provider === 'xai' ? 'grok-api' : `${provider}-api`;
  return {
    id: row.id,
    displayName: typeof row.display_name === 'string' ? row.display_name : row.id,
    routeId,
    provider,
    auth: 'api_key',
    author: provider,
    capabilities: {
      textOutput:
        provider === 'anthropic' || output?.includes('text')
          ? 'supported'
          : support(capability.text_output),
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
    efforts: efforts?.length ? ['off', ...efforts] : undefined,
    ...(efforts?.length && (provider === 'openai' || provider === 'xai')
      ? {
          reasoningControl: {
            parameter: provider,
            disableSupported: false,
            ...(rawEfforts?.includes('xhigh')
              ? { maxWireValue: 'xhigh' }
              : rawEfforts?.includes('max')
                ? { maxWireValue: 'max' }
                : {}),
          },
        }
      : {}),
    // An authenticated model-list response proves listed availability, not that
    // a particular generation endpoint/account will execute a request.
    availability: 'account',
    metadata: { source: ENDPOINTS[provider], stale: false },
  };
}
export function createDirectModelSource(options: DirectModelSourceOptions): ModelDiscoverySource {
  if (!options.apiKey.trim() || !options.accountId.trim())
    throw new Error('Explicit API key and non-secret account scope required');
  const routeId = options.provider === 'xai' ? 'grok-api' : `${options.provider}-api`;
  const headers =
    options.provider === 'anthropic'
      ? { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${options.apiKey}` };
  return {
    routeId,
    cacheKey: options.accountId,
    async discover(context) {
      const rows = await fetchModelPages(ENDPOINTS[options.provider], { ...context, headers });
      const models = new Map<string, ModelRecord>();
      for (const row of rows) {
        const model = normalizeDirectModel(row, options.provider);
        if (model) models.set(model.id, model);
      }
      return [...models.values()];
    },
  };
}
/** Resolves only explicit caller aliases; never substitutes a default or payment route. */
export function resolveModelAlias(model: string, aliases: Record<string, string> = {}): string {
  let id = model;
  const visited = new Set<string>();
  while (Object.hasOwn(aliases, id)) {
    if (visited.has(id)) throw new Error('Model alias cycle');
    visited.add(id);
    const next = aliases[id];
    if (!next?.trim()) throw new Error('Model alias target must be an exact ID');
    id = next;
  }
  return id;
}
/** No subscription discovery endpoint is known. No API credential/login is touched. */
export function createSubscriptionModelSource(
  routeId: 'chatgpt-subscription' | 'grok-subscription',
): ModelDiscoverySource {
  const route = listRoutes().find((candidate) => candidate.id === routeId);
  return {
    routeId,
    async discover() {
      return (
        route?.models.map((id) => ({
          id,
          displayName: id,
          routeId,
          provider: route.provider,
          auth: 'subscription',
          capabilities: {
            textOutput: 'unknown',
            tools: 'unknown',
            images: 'unknown',
            reasoning: 'unknown',
          },
          availability: 'unknown',
          metadata: { source: 'subscription-discovery-unavailable', stale: true },
        })) ?? []
      );
    },
  };
}
