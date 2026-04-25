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

const PRICE_TABLE: Record<string, TokenPricesPerMillion> = {
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
  'anthropic:claude-haiku-latest': {
    input: 0.8,
    output: 4,
    cacheCreationInput: 1,
    cacheReadInput: 0.08,
  },
  'openrouter:anthropic/claude-haiku-latest': {
    input: 0.8,
    output: 4,
  },
  'openai:gpt-4o-mini': {
    input: 0.15,
    output: 0.6,
  },
  'openai:gpt-4o': {
    input: 2.5,
    output: 10,
  },
  'ollama:qwen2.5:3b': ZERO_PRICE,
};

export function estimateCostUsd(provider: string, model: string, usage: TokenUsage): number {
  const prices = PRICE_TABLE[`${provider}:${model}`] ?? ZERO_PRICE;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
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
