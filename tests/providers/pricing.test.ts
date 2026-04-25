import { describe, expect, test } from 'bun:test';
import { estimateCostUsd, formatUsd } from '../../src/providers/pricing.js';

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
});
