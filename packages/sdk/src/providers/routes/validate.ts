// Route model/effort validation (spec 2026-10-08 §4.2). Rejects KNOWN
// incompatible choices before inference; unknown-but-plausible model ids pass
// through so a backend rejection can surface as `model_unsupported` later.
// `auto` (or an absent value) selects the route default.

import { REASONING_EFFORTS, type ReasoningEffort } from '../effort.js';
import { routeDefinition } from './catalog.js';
import { RouteError } from './errors.js';
import { AUTO_SELECTION, type RouteRecord, type RouteSelection } from './types.js';

// Printable, no whitespace, bounded. Rejects empty strings and control bytes.
const MODEL_ID = /^[\x21-\x7e]{1,200}$/;

export type RouteSelectionInput = {
  model?: string;
  effort?: string;
};

/**
 * Validate a model/effort request for `route` and resolve `auto`.
 * Throws `RouteError` with code `model_unsupported` or `effort_unsupported`.
 * With no explicit effort, the route default is used when the chosen model
 * supports it, otherwise `off` (always supported).
 */
export function validateRouteSelection(
  route: RouteRecord,
  input: RouteSelectionInput = {},
): RouteSelection {
  const model = resolveModel(route, input.model);
  const supported = effortsForModel(route, model);
  const effort = resolveEffort(route, model, supported, input.effort);
  return { model, effort };
}

/** Supported effort levels for any model id on `route` (known or not). */
export function effortsForModel(route: RouteRecord, model: string): ReasoningEffort[] {
  const known = route.modelEfforts[model];
  if (known) return [...known];
  const levels = new Set(routeDefinition(route.id).effortsFor(model));
  return REASONING_EFFORTS.filter((level) => levels.has(level));
}

function resolveModel(route: RouteRecord, requested: string | undefined): string {
  if (requested === undefined || requested === AUTO_SELECTION) return route.defaultModel;
  if (!MODEL_ID.test(requested)) {
    throw new RouteError('model_unsupported', `model id is not valid for route ${route.id}`, {
      routeId: route.id,
    });
  }
  if (route.models.includes(requested)) return requested;
  if (route.modelsAuthoritative || routeDefinition(route.id).isKnownIncompatible(requested)) {
    throw new RouteError(
      'model_unsupported',
      `model ${JSON.stringify(requested)} is not supported by route ${route.id}`,
      { routeId: route.id },
    );
  }
  return requested;
}

function resolveEffort(
  route: RouteRecord,
  model: string,
  supported: readonly ReasoningEffort[],
  requested: string | undefined,
): ReasoningEffort {
  if (requested === undefined || requested === AUTO_SELECTION) {
    return supported.includes(route.defaultEffort) ? route.defaultEffort : 'off';
  }
  const level = requested as ReasoningEffort;
  if (!(REASONING_EFFORTS as readonly string[]).includes(requested) || !supported.includes(level)) {
    throw new RouteError(
      'effort_unsupported',
      `effort ${JSON.stringify(requested)} is not supported by route ${route.id} with model ${JSON.stringify(model)}`,
      { routeId: route.id },
    );
  }
  return level;
}
