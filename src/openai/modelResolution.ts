// Phase 18 T2 — per-request model resolution.
//
// Maps the OpenAI `model` field in the ChatCompletions request onto an
// internal { transport, model } pair. v0 (T2) recognizes:
//
//   - 'harness-default' (or '') → runtime's bootstrapped transport + model
//   - everything else           → InvalidModelError (caught by the route,
//                                  surfaced as 400 with the supported model
//                                  list per D6 / OQ2).
//
// T9 will expand this to call `resolveProvider(family, model, ...)` for
// known explicit names — so that a request specifying `gpt-4o` or
// `claude-haiku-4-5-20251001` builds a fresh transport for that one
// request without mutating the runtime's bootstrap. SUPPORTED_MODELS is
// the static catalog the error message references; T9 will keep this list
// (or replace it with one derived from the resolver registry).

import type { LLMProvider } from '../providers/types.js';
import type { Runtime } from '../server/runtime.js';

/** Supported model names for the OpenAI server's `model` field. v0
 *  recognizes only `harness-default`; the explicit-name branch lands in
 *  T9 and will route to `resolveProvider`. The list here is the catalog
 *  surfaced in the InvalidModelError message so users see the recognized
 *  names. */
export const SUPPORTED_MODELS = [
  'harness-default',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
] as const;

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

/** Resolve `requestedModel` against the runtime's bootstrapped provider.
 *
 *  `harness-default` (and empty string) → runtime's transport + model.
 *  Any other name throws InvalidModelError for now. T9 will expand the
 *  explicit-name branch to call `resolveProvider` for per-request
 *  provider/model overrides. */
export function resolveModelForRequest(runtime: Runtime, requestedModel: string): ResolvedModel {
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
  throw new InvalidModelError(requestedModel);
}
