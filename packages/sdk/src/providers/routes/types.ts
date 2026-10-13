// Built-in SOV authentication route types (spec 2026-10-08 §4.1).
// Route records are non-secret: `credentialRef` is a symbolic lookup, never a
// key or token.

import type { ReasoningEffort } from '../effort.js';

/** The six reserved, stable built-in route ids. */
export const ROUTE_IDS = [
  'openrouter-api',
  'anthropic-api',
  'openai-api',
  'grok-api',
  'chatgpt-subscription',
  'grok-subscription',
] as const;

export type RouteId = (typeof ROUTE_IDS)[number];

export type RouteAuth = 'api_key' | 'subscription';

/** Internal transport name. `xai` is the API-key lane; `grok` the subscription. */
export type RouteProvider = 'openrouter' | 'anthropic' | 'openai' | 'xai' | 'chatgpt' | 'grok';

/** Sentinel callers (Telekit) may pass for model or effort: "use the route default". */
export const AUTO_SELECTION = 'auto';

/**
 * Versioned, non-secret route record. Invariants (checked by tests, relied on
 * by Telekit): when `rejectedConfiguredDefault` is absent, `defaultModel` is an
 * element of `models` and `defaultEffort` is an element of
 * `modelEfforts[defaultModel]`. `efforts` is non-empty; every `modelEfforts`
 * value is a non-empty subset of `efforts`. A rejected configured default is
 * not a member of `models` and is not the built-in id.
 */
export type RouteRecord = {
  id: RouteId;
  provider: RouteProvider;
  auth: RouteAuth;
  displayName: string;
  defaultModel: string;
  /** Known compatible model ids. Not exhaustive unless `modelsAuthoritative`. */
  models: string[];
  /** False: unknown-but-plausible model ids pass validation (spec §4.2). */
  modelsAuthoritative: boolean;
  /**
   * Set when `routes.<id>.defaultModel` is outside an authoritative allowlist.
   * `defaultModel` is this rejected id, not the built-in. Selecting `auto` or
   * an omitted model throws `model_unsupported` and names that setting; the
   * rejected id is not used and is not silently replaced.
   */
  rejectedConfiguredDefault?: string;
  /**
   * Present only with `rejectedConfiguredDefault`. Tells the operator that
   * omission and `auto` fail until `routes.<id>.defaultModel` is changed.
   */
  defaultModelNotice?: string;
  /** Effort levels supported by at least one known model. Always contains `off`. */
  efforts: ReasoningEffort[];
  /** Supported effort levels per known model. */
  modelEfforts: Record<string, ReasoningEffort[]>;
  defaultEffort: ReasoningEffort;
  /** Symbolic credential lookup, e.g. `api_key:xai` or `subscription:chatgpt`. */
  credentialRef: string;
  enabled: boolean;
};

/** A validated model + effort pair for one route. `auto` is already resolved. */
export type RouteSelection = {
  model: string;
  effort: ReasoningEffort;
};

export function isRouteId(value: string): value is RouteId {
  return (ROUTE_IDS as readonly string[]).includes(value);
}
