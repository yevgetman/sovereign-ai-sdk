// Exact Grok subscription pin. Not a discovery result and not a live probe.
import type { ModelCatalog, ModelRecord } from './types.js';

export const GROK_SUBSCRIPTION_MODELS = ['grok-4.7', 'grok-4.6'] as const;
export const GROK_SUBSCRIPTION_PIN_SOURCE = 'xai-docs-2026-10-14';
export const GROK_SUBSCRIPTION_CONTEXT_TOKENS = 500_000;

export type GrokSubscriptionModelId = (typeof GROK_SUBSCRIPTION_MODELS)[number];

const PIN_IDS = new Set<string>(GROK_SUBSCRIPTION_MODELS);

export function isGrokSubscriptionModelId(id: string): id is GrokSubscriptionModelId {
  return PIN_IDS.has(id);
}

/** Publisher-documented record. Both model windows are documented by xAI. */
export function grokSubscriptionPin(id: GrokSubscriptionModelId): ModelRecord {
  return {
    id,
    displayName: id,
    routeId: 'grok-subscription',
    provider: 'grok',
    auth: 'subscription',
    ...(id === 'grok-4.7'
      ? {
          imageInputCertification: {
            routeId: 'grok-subscription',
            modelId: id,
            source: 'https://docs.x.ai/developers/model-capabilities/images/understanding',
            verifiedAt: '2026-10-14T17:16:08.259Z',
            expiresAt: '2026-11-13T17:16:08.259Z',
            liveVerification: 'passed' as const,
            mimeTypes: ['image/png', 'image/jpeg'],
          },
        }
      : {}),
    capabilities: {
      textOutput: 'supported',
      tools: 'supported',
      images: 'supported',
      reasoning: 'supported',
    },
    contextWindow: GROK_SUBSCRIPTION_CONTEXT_TOKENS,
    efforts: ['low', 'medium', 'high', 'max'],
    reasoningControl: {
      parameter: 'grok',
      disableSupported: false,
      maxWireValue: 'xhigh',
    },
    availability: 'unknown',
    metadata: {
      source: GROK_SUBSCRIPTION_PIN_SOURCE,
      stale: false,
      fetchedAt: '2026-10-14T00:00:00.000Z',
    },
  };
}

/** Put the two pin records back after stale or unavailable marking. */
export function applyGrokSubscriptionPins(catalog: ModelCatalog): ModelCatalog {
  if (catalog.routeId !== 'grok-subscription') return catalog;
  const pins = GROK_SUBSCRIPTION_MODELS.map((id) => grokSubscriptionPin(id));
  return {
    ...catalog,
    models: [...pins, ...catalog.models.filter((model) => !PIN_IDS.has(model.id))],
  };
}
