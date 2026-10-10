import type { ModelRecord } from './models/types.js';
// Token pricing helpers for the Phase 8 /cost command. Built-in prices are
// intentionally small and explicit. Unknown prices remain unknown.

import type { TokenUsage } from '../core/types.js';

export type TokenPricesPerMillion = {
  input: number;
  output: number;
  cacheCreationInput?: number;
  cacheReadInput?: number;
};

const ZERO_PRICE: TokenPricesPerMillion = { input: 0, output: 0 };

/** Version of the built-in {@link PRICE_TABLE}. Bump on ANY table change
 *  (rate edit, added/removed model). Consumers pin what they priced against
 *  (e.g. assay's `pricing_ref`) so a later rate change never silently
 *  reprices historical usage. */
export const PRICING_VERSION = 1;

export const PRICE_TABLE: Readonly<Record<string, TokenPricesPerMillion>> = {
  'anthropic:claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheCreationInput: 3.75,
    cacheReadInput: 0.3,
  },
  'anthropic:claude-opus-4-7': {
    input: 15,
    output: 75,
    cacheCreationInput: 18.75,
    cacheReadInput: 1.5,
  },
  'anthropic:claude-haiku-4-5-20251001': {
    input: 1,
    output: 5,
    cacheCreationInput: 1.25,
    cacheReadInput: 0.1,
  },
  'anthropic:claude-3-5-haiku-latest': {
    input: 0.8,
    output: 4,
    cacheCreationInput: 1,
    cacheReadInput: 0.08,
  },
  'anthropic:claude-3-5-haiku-20241022': {
    input: 0.8,
    output: 4,
    cacheCreationInput: 1,
    cacheReadInput: 0.08,
  },
  'openrouter:anthropic/claude-3.5-haiku': {
    input: 0.8,
    output: 4,
  },
  'openrouter:anthropic/claude-haiku-4.5': {
    input: 1,
    output: 5,
  },
  // The OpenRouter open-weight lane (Appleo OpenRouter cutover, 2026-08-03;
  // rates from OpenRouter's models API, verified that day). Cache writes are
  // FREE on both (automatic caching), hence no cacheCreationInput.
  'openrouter:z-ai/glm-5.2': {
    input: 0.629,
    output: 1.976,
    cacheReadInput: 0.117,
  },
  'openrouter:moonshotai/kimi-k2.5': {
    input: 0.57,
    output: 2.85,
    cacheReadInput: 0.095,
  },
  'openai:gpt-4o-mini': {
    input: 0.15,
    output: 0.6,
    // OpenAI's cached-input discount is 50% of the input rate.
    cacheReadInput: 0.075,
  },
  'openai:gpt-4o': {
    input: 2.5,
    output: 10,
    cacheReadInput: 1.25,
  },
  'ollama:qwen2.5:3b': ZERO_PRICE,
};

export type CostEstimate = {
  scope?: 'provider' | 'aggregate';
  components?: CostEstimate[];
  usage?: TokenUsage;
  state: 'paid' | 'free' | 'subscription' | 'unknown';
  complete: boolean;
  amountUsd?: number;
  provider: string;
  model: string;
  source: string;
  version: number;
  pricedAt: string;
  rates?: TokenPricesPerMillion;
};

export type PricingSnapshot = {
  state: CostEstimate['state'];
  source: string;
  version?: number;
  fetchedAt?: string;
  rates?: TokenPricesPerMillion;
  provider?: string;
  model?: string;
};

/** Normalize discovery rates without guessing missing rates or subscription bills. */
export function pricingSnapshotForModel(record: ModelRecord): PricingSnapshot {
  const pricing = record.pricing;
  const rates =
    pricing?.inputPerMillion !== undefined && pricing.outputPerMillion !== undefined
      ? {
          input: pricing.inputPerMillion,
          output: pricing.outputPerMillion,
          ...(pricing.cacheReadPerMillion !== undefined
            ? { cacheReadInput: pricing.cacheReadPerMillion }
            : {}),
          ...(pricing.cacheWritePerMillion !== undefined
            ? { cacheCreationInput: pricing.cacheWritePerMillion }
            : {}),
        }
      : undefined;
  const fetchedAt = pricing?.fetchedAt ?? record.metadata.fetchedAt;
  return {
    state:
      record.auth === 'subscription'
        ? 'subscription'
        : (pricing?.state ?? (rates ? 'paid' : 'unknown')),
    source: pricing?.source ?? record.metadata.source,
    provider: record.provider,
    model: record.id,
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(rates ? { rates } : {}),
  };
}

/** Snapshot, not a bill. Never reprice historical estimates after refresh. */
export function estimateUsageCost(
  provider: string,
  model: string,
  usage: TokenUsage,
  suppliedSnapshot?: PricingSnapshot,
): CostEstimate {
  const snapshot =
    suppliedSnapshot &&
    ((suppliedSnapshot.provider && suppliedSnapshot.provider !== provider) ||
      (suppliedSnapshot.model && suppliedSnapshot.model !== model))
      ? { state: 'unknown' as const, source: 'identity-mismatch' }
      : suppliedSnapshot;
  const prices = snapshot ? snapshot.rates : PRICE_TABLE[`${provider}:${model}`];
  const valid =
    prices !== undefined &&
    typeof prices.input === 'number' &&
    typeof prices.output === 'number' &&
    Object.values(prices).every(
      (rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0,
    );
  const state =
    snapshot?.state ??
    (valid ? (prices.input === 0 && prices.output === 0 ? 'free' : 'paid') : 'unknown');
  const cacheRatesKnown =
    !snapshot ||
    ((!usage.cacheReadInputTokens || prices?.cacheReadInput !== undefined) &&
      (!usage.cacheCreationInputTokens || prices?.cacheCreationInput !== undefined));
  const usageValid = Object.values(usage).every(
    (tokens) => tokens === undefined || (Number.isSafeInteger(tokens) && tokens >= 0),
  );
  const amount = valid && usageValid ? priceUsage(prices, usage) : undefined;
  const complete =
    valid &&
    usageValid &&
    cacheRatesKnown &&
    Number.isFinite(amount) &&
    state !== 'subscription' &&
    state !== 'unknown';
  return {
    provider,
    model,
    state: complete
      ? Object.values(prices).every((rate) => rate === 0)
        ? 'free'
        : 'paid'
      : state === 'subscription'
        ? state
        : 'unknown',
    complete,
    source: snapshot?.source ?? (prices ? 'sdk-price-table' : 'unknown'),
    version: snapshot?.version ?? PRICING_VERSION,
    pricedAt: snapshot?.fetchedAt ?? new Date().toISOString(),
    ...(complete && amount !== undefined ? { amountUsd: amount, rates: { ...prices } } : {}),
  };
}

/** @deprecated Use estimateUsageCost for completeness and provenance.
 * Unknown estimates are undefined, never a fabricated zero. */
export function estimateCostUsd(
  provider: string,
  model: string,
  usage: TokenUsage,
): number | undefined {
  return estimateUsageCost(provider, model, usage).amountUsd;
}

function priceUsage(prices: TokenPricesPerMillion, usage: TokenUsage): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  // NOTE: `usage.reasoningTokens` is DELIBERATELY absent from this sum. It is an
  // informational subset of `outputTokens` (already priced via `output` above);
  // adding it would double-count. The four phase fields are disjoint + additive.
  return (
    (input * prices.input) / 1_000_000 +
    (output * prices.output) / 1_000_000 +
    (cacheCreation * (prices.cacheCreationInput ?? prices.input)) / 1_000_000 +
    (cacheRead * (prices.cacheReadInput ?? prices.input)) / 1_000_000
  );
}

export function formatUsd(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
