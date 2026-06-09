// Pure effort-module tests. No providers, no network — exercises the
// level→wire translation, the capability matrix, and the Anthropic
// budget/max_tokens/temperature invariants.

import { describe, expect, test } from 'bun:test';
import {
  type AnthropicThinking,
  EFFORT_BUDGET_TOKENS,
  MAX_TOKENS_CEILING,
  MIN_THINKING_BUDGET,
  REASONING_EFFORTS,
  RESPONSE_HEADROOM,
  type ReasoningEffort,
  anthropicThinkingFor,
  modelSupportsReasoning,
  openAiReasoningFor,
} from '../../src/providers/effort.js';

/** Narrow the optional thinking block; fails loudly if absent. */
function budgetOf(result: AnthropicThinking): number {
  expect(result.thinking).toBeDefined();
  const thinking = result.thinking;
  if (!thinking) throw new Error('expected thinking to be present');
  return thinking.budget_tokens;
}

describe('effort constants + vocabulary', () => {
  test('level vocabulary is exactly off/low/medium/high/max', () => {
    expect(REASONING_EFFORTS).toEqual(['off', 'low', 'medium', 'high', 'max']);
  });

  test('budget table matches the design', () => {
    expect(EFFORT_BUDGET_TOKENS).toEqual({
      off: 0,
      low: 4000,
      medium: 8000,
      high: 16000,
      max: 24000,
    });
  });

  test('numeric constants', () => {
    expect(RESPONSE_HEADROOM).toBe(8192);
    expect(MIN_THINKING_BUDGET).toBe(1024);
    expect(MAX_TOKENS_CEILING).toBe(32000);
  });
});

describe('modelSupportsReasoning', () => {
  test('anthropic 4.x hybrid family supports thinking (incl. the harness default)', () => {
    expect(modelSupportsReasoning('claude-haiku-4-5-20251001', 'anthropic')).toBe(true);
    expect(modelSupportsReasoning('claude-sonnet-4-6', 'anthropic')).toBe(true);
    expect(modelSupportsReasoning('claude-opus-4-8', 'anthropic')).toBe(true);
  });

  test('anthropic pre-4 models do NOT support thinking', () => {
    expect(modelSupportsReasoning('claude-3-5-haiku', 'anthropic')).toBe(false);
    expect(modelSupportsReasoning('claude-3-5-sonnet-20241022', 'anthropic')).toBe(false);
    expect(modelSupportsReasoning('claude-2.1', 'anthropic')).toBe(false);
  });

  test('matching is case-insensitive', () => {
    expect(modelSupportsReasoning('CLAUDE-SONNET-4-6', 'anthropic')).toBe(true);
    expect(modelSupportsReasoning('GPT-5', 'openai')).toBe(true);
  });

  test('openai reasoning families supported; chat families not', () => {
    expect(modelSupportsReasoning('o1', 'openai')).toBe(true);
    expect(modelSupportsReasoning('o1-mini', 'openai')).toBe(true);
    expect(modelSupportsReasoning('o3', 'openai')).toBe(true);
    expect(modelSupportsReasoning('o3-mini', 'openai')).toBe(true);
    expect(modelSupportsReasoning('o4-mini', 'openai')).toBe(true);
    expect(modelSupportsReasoning('gpt-5', 'openai')).toBe(true);
    expect(modelSupportsReasoning('gpt-5-mini', 'openai')).toBe(true);
    expect(modelSupportsReasoning('gpt-4o', 'openai')).toBe(false);
    expect(modelSupportsReasoning('gpt-4-turbo', 'openai')).toBe(false);
    expect(modelSupportsReasoning('gpt-3.5-turbo', 'openai')).toBe(false);
  });

  test('o-family match is not fooled by substrings inside other words', () => {
    // "go1" / "info3" must not be read as the o1/o3 reasoning families.
    expect(modelSupportsReasoning('cargo1', 'openai')).toBe(false);
    expect(modelSupportsReasoning('info3-model', 'openai')).toBe(false);
  });

  test('sov and ollama always supported; unknown apiMode never', () => {
    expect(modelSupportsReasoning('anything', 'sov')).toBe(true);
    expect(modelSupportsReasoning('whatever', 'ollama')).toBe(true);
    // ApiMode is a closed union, but guard the default branch defensively.
    expect(modelSupportsReasoning('x', 'mystery' as never)).toBe(false);
  });
});

describe('anthropicThinkingFor', () => {
  test('off → no thinking, no max_tokens change, dropTemperature false', () => {
    const result = anthropicThinkingFor('off', 4096);
    expect(result).toEqual({ maxTokens: 4096, dropTemperature: false });
    expect('thinking' in result).toBe(false);
  });

  test('low: budget 4000, max_tokens raised to budget+headroom, drops temperature', () => {
    const result = anthropicThinkingFor('low', 4096);
    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
    expect(result.maxTokens).toBe(4000 + RESPONSE_HEADROOM); // 12192
    expect(result.dropTemperature).toBe(true);
    expect(budgetOf(result)).toBeLessThan(result.maxTokens);
  });

  test('medium: budget 8000', () => {
    const result = anthropicThinkingFor('medium', 4096);
    expect(budgetOf(result)).toBe(8000);
    expect(result.maxTokens).toBe(8000 + RESPONSE_HEADROOM); // 16192
    expect(budgetOf(result)).toBeLessThan(result.maxTokens);
  });

  test('high: budget 16000', () => {
    const result = anthropicThinkingFor('high', 4096);
    expect(budgetOf(result)).toBe(16000);
    expect(result.maxTokens).toBe(16000 + RESPONSE_HEADROOM); // 24192
    expect(budgetOf(result)).toBeLessThan(result.maxTokens);
  });

  test('max: budget 24000, max_tokens clamped to the 32000 ceiling, still budget < max', () => {
    const result = anthropicThinkingFor('max', 4096);
    // 24000 + 8192 = 32192 > 32000 ceiling → clamp to 32000.
    expect(result.maxTokens).toBe(MAX_TOKENS_CEILING);
    expect(budgetOf(result)).toBe(24000);
    expect(budgetOf(result)).toBeLessThan(result.maxTokens);
    expect(result.dropTemperature).toBe(true);
  });

  test('existing larger max_tokens is preserved, not lowered', () => {
    const result = anthropicThinkingFor('low', 20000);
    // max(20000, 4000+8192) = 20000.
    expect(result.maxTokens).toBe(20000);
    expect(budgetOf(result)).toBe(4000);
  });

  test('budget < max_tokens invariant holds for every on-level even with a tiny maxTokens', () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as ReasoningEffort[]) {
      const result = anthropicThinkingFor(effort, 2000);
      const budget = budgetOf(result);
      expect(budget).toBeGreaterThanOrEqual(MIN_THINKING_BUDGET);
      expect(budget).toBeLessThan(result.maxTokens);
      expect(result.maxTokens).toBeLessThanOrEqual(MAX_TOKENS_CEILING);
    }
  });

  test('clamp path: max effort at the ceiling keeps budget strictly below max_tokens', () => {
    // With max effort and maxTokens already at the ceiling, newMax = 32000 and
    // budget = 24000 < 32000 — verify the budget<max invariant holds at the edge.
    const result = anthropicThinkingFor('max', MAX_TOKENS_CEILING);
    expect(result.maxTokens).toBe(MAX_TOKENS_CEILING);
    expect(budgetOf(result)).toBeLessThan(result.maxTokens);
  });
});

describe('openAiReasoningFor', () => {
  test('off → empty object (nothing to spread)', () => {
    expect(openAiReasoningFor('off')).toEqual({});
  });

  test('low/medium/high map straight through', () => {
    expect(openAiReasoningFor('low')).toEqual({ reasoning_effort: 'low' });
    expect(openAiReasoningFor('medium')).toEqual({ reasoning_effort: 'medium' });
    expect(openAiReasoningFor('high')).toEqual({ reasoning_effort: 'high' });
  });

  test('max collapses to high (OpenAI scale tops out at high)', () => {
    expect(openAiReasoningFor('max')).toEqual({ reasoning_effort: 'high' });
  });
});
