// Built-in route catalog (spec 2026-10-08 §2, §4.1, §4.2).
//
// Data sources, read-only:
//  - API-key default models: PROVIDER_REGISTRY (models.ts).
//  - Subscription default models: SUBSCRIPTION_DEFAULT_MODEL (subscription/names.ts).
//  - Effort support: the effort table predicates (effort.ts) — the same
//    predicates the transports use, so a route never advertises an effort the
//    transport would silently drop.
//
// Default-model overrides (least invasive, existing SOV config):
//   settings.routes.<routeId>.defaultModel
//   > settings.providers.<provider>.model   (API-key routes only; existing key)
//   > built-in default.
// An incompatible explicit default is refused; configuration cannot silently
// change the requested model to the built-in default.

import type { Settings } from '../../config/schema.js';
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  modelSupportsReasoning,
  openrouterModelSupportsReasoning,
} from '../effort.js';
import { PROVIDER_REGISTRY } from '../models.js';
import { SUBSCRIPTION_DEFAULT_MODEL } from '../subscription/names.js';
import { RouteError } from './errors.js';
import {
  ROUTE_IDS,
  type RouteAuth,
  type RouteId,
  type RouteProvider,
  type RouteRecord,
  isRouteId,
} from './types.js';

const NO_EFFORT: readonly ReasoningEffort[] = ['off'];

/**
 * Effort levels the subscription transports honor today. The ChatGPT Codex body maps max to xhigh.
 * Grok currently has no verified effort parameter, so only off is supported.
 */
export const SUBSCRIPTION_ROUTE_EFFORTS: Readonly<
  Record<'chatgpt' | 'grok', readonly ReasoningEffort[]>
> = {
  chatgpt: ['low', 'medium', 'high', 'max'],
  grok: NO_EFFORT,
};

/**
 * Routes whose transport sends verified native image content. Anthropic sends
 * native `image` blocks; the OpenAI-compatible transport sends `image_url` data
 * URIs for openai and openrouter. Direct xAI and both subscriptions stay false
 * until verified (spec §5.2: advertise only verified paths). Per-model vision
 * support on OpenRouter is not checked here.
 */
export const ROUTE_IMAGE_SUPPORT: Readonly<Record<RouteId, boolean>> = {
  'openrouter-api': true,
  'anthropic-api': true,
  'openai-api': true,
  'grok-api': false,
  'chatgpt-subscription': false,
  'grok-subscription': false,
};

export function routeSupportsImages(routeId: string): boolean {
  return isRouteId(routeId) && ROUTE_IMAGE_SUPPORT[routeId];
}

/** Route ids with verified native image input, in catalog order. */
export function imageRoutes(): RouteId[] {
  return ROUTE_IDS.filter((id) => ROUTE_IMAGE_SUPPORT[id]);
}

/** Model-family markers used to detect KNOWN-incompatible ids on direct routes. */
const FAMILY: Record<'anthropic' | 'openai' | 'xai', RegExp> = {
  anthropic: /^claude/i,
  openai: /^(gpt-|chatgpt|codex|o[1-9](-|$))/i,
  xai: /^grok/i,
};

type RouteDefinition = {
  id: RouteId;
  provider: RouteProvider;
  auth: RouteAuth;
  displayName: string;
  builtinDefaultModel: string;
  knownModels: readonly string[];
  /** Supported effort levels for any model id on this route. */
  effortsFor: (model: string) => readonly ReasoningEffort[];
  /** True when `model` is KNOWN not to work on this backend. */
  isKnownIncompatible: (model: string) => boolean;
};

function allOrOff(supports: boolean): readonly ReasoningEffort[] {
  return supports ? REASONING_EFFORTS : NO_EFFORT;
}

/** Direct (non-OpenRouter) backends reject `vendor/model` ids and other families. */
function directFamilyRule(own: keyof typeof FAMILY): (model: string) => boolean {
  return (model) => {
    if (model.includes('/')) return true;
    return Object.entries(FAMILY).some(([family, re]) => family !== own && re.test(model));
  };
}

const DEFINITIONS: Readonly<Record<RouteId, RouteDefinition>> = {
  'openrouter-api': {
    id: 'openrouter-api',
    provider: 'openrouter',
    auth: 'api_key',
    displayName: 'OpenRouter (API key)',
    builtinDefaultModel: requiredDefault('openrouter'),
    knownModels: [
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-4.5',
      'z-ai/glm-5.2',
      'moonshotai/kimi-k2.5',
    ],
    effortsFor: (model) => allOrOff(openrouterModelSupportsReasoning(model)),
    // OpenRouter ids are always `vendor/model`; a bare id is a direct-API id.
    isKnownIncompatible: (model) => !model.includes('/'),
  },
  'anthropic-api': {
    id: 'anthropic-api',
    provider: 'anthropic',
    auth: 'api_key',
    displayName: 'Anthropic (API key)',
    builtinDefaultModel: requiredDefault('anthropic'),
    knownModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'],
    effortsFor: (model) => allOrOff(modelSupportsReasoning(model, 'anthropic')),
    isKnownIncompatible: directFamilyRule('anthropic'),
  },
  'openai-api': {
    id: 'openai-api',
    provider: 'openai',
    auth: 'api_key',
    displayName: 'OpenAI (API key)',
    builtinDefaultModel: requiredDefault('openai'),
    knownModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-5'],
    effortsFor: (model) => allOrOff(modelSupportsReasoning(model, 'openai')),
    isKnownIncompatible: directFamilyRule('openai'),
  },
  'grok-api': {
    id: 'grok-api',
    provider: 'xai',
    auth: 'api_key',
    displayName: 'xAI Grok (API key)',
    builtinDefaultModel: requiredDefault('xai'),
    knownModels: ['grok-4.6'],
    // Same predicate the OpenAI-compatible transport applies to the xai lane.
    effortsFor: (model) => allOrOff(modelSupportsReasoning(model, 'openai')),
    isKnownIncompatible: directFamilyRule('xai'),
  },
  'chatgpt-subscription': {
    id: 'chatgpt-subscription',
    provider: 'chatgpt',
    auth: 'subscription',
    displayName: 'ChatGPT (subscription)',
    builtinDefaultModel: SUBSCRIPTION_DEFAULT_MODEL.chatgpt,
    knownModels: [SUBSCRIPTION_DEFAULT_MODEL.chatgpt],
    effortsFor: () => SUBSCRIPTION_ROUTE_EFFORTS.chatgpt,
    isKnownIncompatible: directFamilyRule('openai'),
  },
  'grok-subscription': {
    id: 'grok-subscription',
    provider: 'grok',
    auth: 'subscription',
    displayName: 'Grok (subscription)',
    builtinDefaultModel: SUBSCRIPTION_DEFAULT_MODEL.grok,
    knownModels: [SUBSCRIPTION_DEFAULT_MODEL.grok],
    effortsFor: () => SUBSCRIPTION_ROUTE_EFFORTS.grok,
    isKnownIncompatible: directFamilyRule('xai'),
  },
};

function requiredDefault(provider: string): string {
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) throw new Error(`route catalog: provider ${provider} is not registered`);
  return entry.defaultModel;
}

/** Internal: the behavior behind a route id. Used by validation. */
export function routeDefinition(id: RouteId): RouteDefinition {
  return DEFINITIONS[id];
}

function configuredDefaultModel(def: RouteDefinition, settings: Settings): string | undefined {
  const routeOverride = settings.routes?.[def.id]?.defaultModel;
  if (routeOverride !== undefined) return routeOverride;
  if (def.auth !== 'api_key') return undefined;
  const providers = settings.providers;
  if (def.provider === 'anthropic') return providers?.anthropic?.model;
  if (def.provider === 'openai') return providers?.openai?.model;
  if (def.provider === 'openrouter') return providers?.openrouter?.model;
  if (def.provider === 'xai') return providers?.xai?.model;
  return undefined;
}

function orderedEfforts(levels: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const set = new Set(levels);
  return REASONING_EFFORTS.filter((level) => set.has(level));
}

function buildRecord(def: RouteDefinition, settings: Settings): RouteRecord {
  const override = configuredDefaultModel(def, settings)?.trim();
  if (
    override !== undefined &&
    (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(override) || def.isKnownIncompatible(override))
  ) {
    throw new RouteError(
      'model_unsupported',
      `configured default model is not supported by route ${def.id}`,
      { routeId: def.id },
    );
  }
  const defaultModel = override ?? def.builtinDefaultModel;
  const models = def.knownModels.includes(defaultModel)
    ? [...def.knownModels]
    : [defaultModel, ...def.knownModels];
  const modelEfforts: Record<string, ReasoningEffort[]> = Object.fromEntries(
    models.map((model) => [model, orderedEfforts(def.effortsFor(model))]),
  );
  const efforts = orderedEfforts(Object.values(modelEfforts).flat());
  const configuredEffort = settings.thinking?.effort ?? 'off';
  const defaultEffort = modelEfforts[defaultModel]?.includes(configuredEffort)
    ? configuredEffort
    : (modelEfforts[defaultModel]?.[0] ?? 'off');
  return {
    id: def.id,
    provider: def.provider,
    auth: def.auth,
    displayName: def.displayName,
    defaultModel,
    models,
    modelsAuthoritative: false,
    efforts,
    modelEfforts,
    defaultEffort,
    credentialRef: `${def.auth}:${def.provider}`,
    enabled: true,
  };
}

/** Every built-in route, enabled or not, with config-derived defaults. No I/O. */
export function listRoutes(settings: Settings = {}): RouteRecord[] {
  return ROUTE_IDS.map((id) => buildRecord(DEFINITIONS[id], settings));
}

/** One route by id. An unknown id throws `RouteError('route_unavailable')`. */
export function getRoute(id: string, settings: Settings = {}): RouteRecord {
  if (!isRouteId(id)) {
    throw new RouteError('route_unavailable', `unknown route ${JSON.stringify(id)}`, {
      routeId: id,
    });
  }
  return buildRecord(DEFINITIONS[id], settings);
}
