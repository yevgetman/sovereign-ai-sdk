// Route model/effort validation (spec 2026-10-08 §4.2). Authoritative routes
// refuse ids outside the allowlist. Other routes still reject known-incompatible
// ids; unknown-but-plausible ids pass through so a backend rejection can surface
// as `model_unsupported` later. `auto` or an omitted model selects the route
// default only when `rejectedConfiguredDefault` is absent.

import { REASONING_EFFORTS, type ReasoningEffort } from '../effort.js';
import {
  anthropicReasoningControlFor,
  hasReasoningMetadata,
  preservesEstablishedReasoning,
  reasoningControlFor,
} from '../modelReasoning.js';
import { isOwnerGrokModel } from '../models/ownerModelPolicy.js';
import {
  SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE,
  selectableSubscriptionEfforts,
} from '../models/subscriptionCatalog.js';
import type { ModelRecord } from '../models/types.js';
import { routeDefinition } from './catalog.js';
import { RouteError } from './errors.js';
import { AUTO_SELECTION, type RouteRecord, type RouteSelection } from './types.js';

// Printable, no whitespace, bounded. Rejects empty strings and control bytes.
const MODEL_ID = /^[\x21-\x7e]{1,200}$/;

export type RouteSelectionInput = {
  model?: string;
  effort?: string;
  modelMetadata?: ModelRecord;
};

/**
 * Validate a model/effort request for `route` and resolve `auto`.
 * Throws `RouteError` with code `model_unsupported` or `effort_unsupported`.
 * With no explicit effort, the route default is used when the chosen model
 * supports it. `off` is used only when that model supports it. If neither is
 * supported, this throws `effort_unsupported`.
 */
export function validateRouteSelection(
  route: RouteRecord,
  input: RouteSelectionInput = {},
): RouteSelection {
  const model = resolveModel(route, input.model, input.modelMetadata);
  const supported = effortsForModel(route, model, input.modelMetadata);
  const effort = resolveEffort(route, model, supported, input.effort);
  return { model, effort };
}

/** Supported effort levels for any model id on `route` (known or not). */
export function effortsForModel(
  route: RouteRecord,
  model: string,
  metadata?: ModelRecord,
): ReasoningEffort[] {
  if (metadata && metadata.routeId !== route.id)
    throw new RouteError('effort_unsupported', 'model metadata belongs to another route');
  if (metadata?.metadata.source === SUBSCRIPTION_ACCOUNT_CATALOG_SOURCE) {
    if (metadata.id !== model || metadata.provider !== route.provider)
      throw new RouteError('effort_unsupported', 'model metadata does not match request');
    if (route.provider === 'grok') {
      const grok = reasoningControlFor('grok', model, metadata);
      if (metadata.capabilities.reasoning === 'unsupported') return [];
      if (metadata.efforts?.length === 0) return [];
      if (grok && grok.efforts.length === 0 && (metadata.efforts?.length ?? 0) > 0) return [];
    }
    return selectableSubscriptionEfforts(metadata);
  }
  if (route.provider === 'anthropic')
    return [...anthropicReasoningControlFor(model, metadata).efforts];
  const control = reasoningControlFor(route.provider, model, metadata);
  if (control) return [...control.efforts];
  const established = routeDefinition(route.id).effortsFor(model);
  const partialPreservesEstablished = preservesEstablishedReasoning(
    metadata,
    established.some((level) => level !== 'off'),
  );
  if (hasReasoningMetadata(metadata) && !partialPreservesEstablished) return ['off'];
  const known = route.modelEfforts[model];
  if (known) return [...known];
  const levels = new Set(routeDefinition(route.id).effortsFor(model));
  return REASONING_EFFORTS.filter((level) => levels.has(level));
}

function resolveModel(
  route: RouteRecord,
  requested: string | undefined,
  metadata?: ModelRecord,
): string {
  const ownerId =
    requested === undefined || requested === AUTO_SELECTION ? route.defaultModel : requested;
  if (route.id === 'grok-subscription' && isOwnerGrokModel(metadata, ownerId)) {
    if (metadata?.metadata.retired)
      throw new RouteError(
        'model_unsupported',
        'The owner registry marks the selected model retired.',
        { routeId: route.id },
      );
    if (MODEL_ID.test(ownerId)) return ownerId;
  }
  if (requested === undefined || requested === AUTO_SELECTION) {
    const rejected = route.rejectedConfiguredDefault;
    if (rejected !== undefined) {
      throw new RouteError(
        'model_unsupported',
        `configured default model ${JSON.stringify(rejected)} in routes.${route.id}.defaultModel is not supported by route ${route.id}`,
        { routeId: route.id },
      );
    }
    return route.defaultModel;
  }
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
    if (supported.includes(route.defaultEffort)) return route.defaultEffort;
    if (supported.includes('off')) return 'off';
    // Empty means this transport can send nothing, not that its default level lost.
    const message =
      supported.length === 0
        ? 'this model has no subscription effort this transport can send'
        : `effort ${JSON.stringify(route.defaultEffort)} is not supported by route ${route.id} with model ${JSON.stringify(model)}`;
    throw new RouteError('effort_unsupported', message, { routeId: route.id });
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
