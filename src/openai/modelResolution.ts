// Phase 18 T2 + T9 — per-request model resolution.
//
// Maps the OpenAI `model` field in the ChatCompletions request onto an
// internal { transport, model } pair:
//
//   - 'harness-default' (or '') → runtime's bootstrapped transport + model
//                                  (the cheap-and-fast path — no fresh
//                                  credential discovery, no extra resolver
//                                  call, just hand back what buildRuntime
//                                  already wired up).
//   - known explicit name (T9)  → call resolveProvider(family, model, {
//                                  harnessHome }) to build a per-request
//                                  transport. The result is used for THIS
//                                  request only; runtime state is NOT
//                                  mutated. Each call to resolveProvider
//                                  is cheap (pool/guard files are lazily
//                                  opened) and per-request resolution gets
//                                  fresh rate-guard state, which is the
//                                  safer v0 default. If profiling shows a
//                                  problem, an LRU layer lands later.
//   - everything else           → InvalidModelError (caught by the route,
//                                  surfaced as 400 with the supported model
//                                  list per D6 / OQ2).
//
// Family inference: `claude-*` → 'anthropic'; `gpt-*` → 'openai'. The
// resolver normalizes these names so passing the family directly is the
// canonical path. The SUPPORTED_MODELS list is the authoritative catalog
// also surfaced by GET /v1/models (T7) and in the InvalidModelError
// message.

import { resolveProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import type { Runtime } from '../server/runtime.js';

/** Supported model names for the OpenAI server's `model` field.
 *  `harness-default` routes to the runtime's bootstrapped transport.
 *  Explicit names route through `resolveProvider` so per-request
 *  provider/model overrides work without mutating the runtime. The
 *  list here is the catalog surfaced both in the InvalidModelError
 *  message AND by GET /v1/models (see routes/models.ts). */
export const SUPPORTED_MODELS = [
  'harness-default',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export class InvalidModelError extends Error {
  constructor(requestedModel: string) {
    super(`unknown model '${requestedModel}'. Supported models: ${SUPPORTED_MODELS.join(', ')}.`);
    this.name = 'InvalidModelError';
  }
}

export type ResolvedModel = {
  transport: LLMProvider;
  model: string;
};

/** Family the resolver expects (`name` arg) for a given supported model.
 *  Returns null for `harness-default` (handled separately) and for any
 *  string that doesn't match a known family prefix. */
function modelFamily(model: string): 'anthropic' | 'openai' | null {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  return null;
}

/** Resolve `requestedModel` against the runtime + (for explicit names) the
 *  provider resolver.
 *
 *  - `harness-default` (and empty string): runtime's transport + model.
 *  - Known SUPPORTED_MODELS name with a recognized family: calls
 *    `resolveProvider(family, requestedModel, { harnessHome })` to build a
 *    per-request transport. May throw `CredentialUnavailableError` (no API
 *    key configured for that family) or other resolver errors — the route
 *    surfaces those as 500 / authentication errors.
 *  - Anything else: throws `InvalidModelError`.
 *
 *  `harnessHome` is required for the resolver to locate credentials + rate
 *  guard state on disk; pass `runtime.harnessHome` from the route. */
export function resolveModelForRequest(
  runtime: Runtime,
  requestedModel: string,
  harnessHome: string,
): ResolvedModel {
  if (requestedModel === 'harness-default' || requestedModel === '') {
    return {
      // Transport extends LLMProvider — the runtime's resolvedProvider.transport
      // is already typed compatibly. The route only needs the .stream() entry
      // point query() consumes, so widening to LLMProvider keeps the surface
      // minimal and decoupled from the richer Transport adapter contract.
      transport: runtime.resolvedProvider.transport,
      model: runtime.model,
    };
  }

  if (!(SUPPORTED_MODELS as readonly string[]).includes(requestedModel)) {
    throw new InvalidModelError(requestedModel);
  }

  const family = modelFamily(requestedModel);
  if (family === null) {
    // Defensive: a model is in SUPPORTED_MODELS but doesn't match a known
    // family prefix. Should never happen with the current catalog but
    // we don't want a silent fall-through if the list ever picks up a
    // new family without the prefix logic catching up.
    throw new InvalidModelError(requestedModel);
  }

  const resolved = resolveProvider(family, requestedModel, { harnessHome });
  return {
    transport: resolved.transport,
    model: requestedModel,
  };
}
