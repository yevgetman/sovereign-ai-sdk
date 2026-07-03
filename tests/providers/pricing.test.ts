import { describe, expect, test } from 'bun:test';
import {
  PRICE_TABLE,
  PRICING_VERSION,
  estimateCostUsd,
  formatUsd,
} from '@yevgetman/sov-sdk/providers/pricing';

describe('provider pricing helpers', () => {
  test('estimates known model cost including cache lanes', () => {
    const cost = estimateCostUsd('anthropic', 'claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    expect(cost).toBe(22.05);
  });

  test('unknown models still report zero estimated dollars', () => {
    const cost = estimateCostUsd('unknown', 'unknown', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(0);
  });

  test('formats tiny and normal dollar amounts', () => {
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(1.234)).toBe('$1.23');
  });

  // T3 / F6 — OpenAI cached-input is priced at its own (discounted) rate.
  test('prices OpenAI cache-read tokens at the published 50%-of-input rate', () => {
    // gpt-4o: input 2.5, cacheReadInput 1.25. 1M cache-read tokens → $1.25.
    expect(estimateCostUsd('openai', 'gpt-4o', { cacheReadInputTokens: 1_000_000 })).toBeCloseTo(
      1.25,
      10,
    );
    // gpt-4o-mini: input 0.15, cacheReadInput 0.075. 1M cache-read → $0.075.
    expect(
      estimateCostUsd('openai', 'gpt-4o-mini', { cacheReadInputTokens: 1_000_000 }),
    ).toBeCloseTo(0.075, 10);
  });

  // T3 / F6 — reasoningTokens is a SUBSET of outputTokens and must NEVER be added
  // to cost (adding it would double-count). Same usage ± reasoningTokens = same $.
  test('reasoningTokens does not change estimated cost (double-count pin)', () => {
    const base = { inputTokens: 1000, outputTokens: 2000 };
    const withReasoning = { ...base, reasoningTokens: 1500 };
    expect(estimateCostUsd('openai', 'gpt-4o', withReasoning)).toBe(
      estimateCostUsd('openai', 'gpt-4o', base),
    );
  });

  test('PRICING_VERSION is the pinned integer 1', () => {
    expect(PRICING_VERSION).toBe(1);
  });

  test('PRICE_TABLE is exported and carries the OpenAI cache-read entries', () => {
    expect(PRICE_TABLE['openai:gpt-4o']?.cacheReadInput).toBe(1.25);
    expect(PRICE_TABLE['openai:gpt-4o-mini']?.cacheReadInput).toBe(0.075);
  });
});
