// Token pricing helpers for the Phase 8 /cost command. Built-in prices are
// intentionally small and explicit; unknown models fall back to zero cost
// while still reporting token counts.

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

export function estimateCostUsd(provider: string, model: string, usage: TokenUsage): number {
  const prices = PRICE_TABLE[`${provider}:${model}`] ?? ZERO_PRICE;
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
