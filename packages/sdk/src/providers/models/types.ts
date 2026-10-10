import type { ReasoningEffort } from '../effort.js';

export const MODEL_CATALOG_VERSION = 1 as const;
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';
export type ModelAvailability = 'advertised' | 'account' | 'unknown';
/** Unknown properties are omitted, never represented by zero or guessed from an ID. */
export interface ModelRecord {
  id: string;
  displayName: string;
  routeId: string;
  provider: string;
  auth: 'api_key' | 'subscription' | 'custom';
  author?: string | undefined;
  inferenceHost?: string | undefined;
  capabilities: {
    textOutput: CapabilitySupport;
    tools: CapabilitySupport;
    images: CapabilitySupport;
    reasoning: CapabilitySupport;
  };
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  efforts?: ReasoningEffort[] | undefined;
  pricing?:
    | {
        inputPerMillion?: number | undefined;
        outputPerMillion?: number | undefined;
        cacheReadPerMillion?: number | undefined;
        cacheWritePerMillion?: number | undefined;
        state?: 'paid' | 'free' | 'subscription' | 'unknown' | undefined;
        fetchedAt?: string | undefined;
        currency: 'USD';
        source: string;
      }
    | undefined;
  availability: ModelAvailability;
  metadata: { source: string; fetchedAt?: string | undefined; stale: boolean };
}
export interface ModelCatalog {
  version: typeof MODEL_CATALOG_VERSION;
  routeId: string;
  models: ModelRecord[];
  state: 'current' | 'stale' | 'unavailable';
  fetchedAt?: string | undefined;
  error?: string | undefined;
}
export type ModelFetch = typeof globalThis.fetch;
export interface ModelCatalogCache {
  get(key: string): Promise<ModelCatalog | undefined>;
  set(key: string, catalog: ModelCatalog): Promise<void>;
}
export interface ModelDiscoverySource {
  routeId: string;
  /** Caller-scoped identity without credentials, so accounts never share cached availability. */
  cacheKey?: string | undefined;
  discover(options: { fetch: ModelFetch; signal: AbortSignal }): Promise<ModelRecord[]>;
}
export interface ModelDiscoveryOptions {
  cache?: ModelCatalogCache;
  fetch?: ModelFetch;
  ttlMs?: number | undefined;
  timeoutMs?: number | undefined;
  now?: () => number;
}
