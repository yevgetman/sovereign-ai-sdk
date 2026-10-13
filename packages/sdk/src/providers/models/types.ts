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
  /** Native Anthropic modes explicitly published by its model API. */
  anthropicThinkingModes?: ('enabled' | 'adaptive')[] | undefined;
  /** Whether native output_config.effort is supported, separate from thinking budgets. */
  anthropicEffortSupported?: boolean | undefined;
  /** Verified adapter mapping. Capability=true alone does not establish depth controls. */
  reasoningControl?:
    | {
        parameter: 'openrouter' | 'openai' | 'xai';
        disableSupported: boolean;
        binary?: boolean;
        maxWireValue?: string;
      }
    | undefined;
  /** Known tool-choice formats; omitted means not advertised. */
  toolChoices?: ('auto' | 'any' | 'tool')[] | undefined;
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
  /**
   * Reviewed subscription pin when a current account list omitted it or the
   * pin row was retired or non-text. Never a substitute model id.
   */
  pinnedDefault?: { id: string; status: 'missing' | 'unavailable' } | undefined;
}
export type ModelFetch = typeof globalThis.fetch;
export interface ModelCatalogCache {
  get(key: string): Promise<ModelCatalog | undefined>;
  /**
   * `expected`, when passed, replaces only that still-stored entry. A missing
   * entry stays missing. Callers must not treat fetchedAt and ids as identity.
   */
  set(key: string, catalog: ModelCatalog, expected?: ModelCatalog): Promise<void>;
}
export interface ModelDiscoverySource {
  routeId: string;
  /**
   * Subscription default is `${service}:${service}`. Accounts on that service
   * share the slot, and an account change deletes the route directory.
   */
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
