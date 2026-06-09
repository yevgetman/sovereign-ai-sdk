// Reasoning-depth ("effort") control. Pure, provider-agnostic translation of a
// named effort level into the per-provider wire parameters that turn extended
// thinking / reasoning on (Anthropic `thinking.budget_tokens`, OpenAI
// `reasoning_effort`, sov/ollama `enable_thinking`).
//
// This module imports ONLY the ApiMode type — no provider classes — so it stays
// a leaf the adapters depend on, never the reverse. The adapters (anthropic.ts /
// openai.ts) consume these helpers in buildKwargs.
//
// Design: the `/effort` reasoning-depth feature (Slice A, T1). Default-off:
// `off` / undefined must leave the request body byte-identical to today.

import type { ApiMode } from './types.js';

/** Named reasoning-depth levels. The only vocabulary callers may use. */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Per-level Anthropic thinking budget (in tokens). `off` is 0 and never reaches
 * the on-path. `max` is the design ceiling before the budget < max_tokens clamp
 * in anthropicThinkingFor.
 */
export const EFFORT_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  off: 0,
  low: 4000,
  medium: 8000,
  high: 16000,
  max: 24000,
};

/** Tokens reserved for the visible answer on top of the thinking budget. */
export const RESPONSE_HEADROOM = 8192;
/** Anthropic's documented minimum thinking budget. */
export const MIN_THINKING_BUDGET = 1024;
/** Hard upper bound on max_tokens we'll ever raise a request to. */
export const MAX_TOKENS_CEILING = 32000;

/**
 * Whether `model` supports extended thinking / reasoning under `apiMode`.
 * Only when this returns true do the adapters attach any thinking/reasoning
 * parameter — a non-reasoning model must keep a byte-identical request.
 *
 * Matching is case-insensitive on the model id.
 *  - anthropic: the 4.x hybrid family (haiku/sonnet/opus -4) supports thinking;
 *    pre-4 (claude-3*, claude-2*) does not.
 *  - openai: o1/o3/o4/gpt-5 reasoning families do; gpt-4x/gpt-3x do not.
 *  - sov / ollama: always (the local engines gate it themselves).
 *  - unknown apiMode: never.
 */
export function modelSupportsReasoning(model: string, apiMode: ApiMode): boolean {
  const id = model.toLowerCase();
  switch (apiMode) {
    case 'anthropic':
      return /claude-(haiku|sonnet|opus)-4/.test(id);
    case 'openai':
      return /(^|[^a-z])(o1|o3|o4)([^a-z]|$)/.test(id) || /gpt-5/.test(id);
    case 'sov':
    case 'ollama':
      return true;
    default:
      return false;
  }
}

/** Anthropic thinking parameters derived from an effort level. */
export type AnthropicThinking = {
  /** Omitted entirely when effort is `off`. */
  thinking?: { type: 'enabled'; budget_tokens: number };
  /** Possibly-raised max_tokens (budget needs headroom under it). */
  maxTokens: number;
  /** True when temperature must be dropped (the API rejects temp≠1 with thinking on). */
  dropTemperature: boolean;
};

/**
 * Translate an effort level into Anthropic thinking parameters, honoring the
 * API's constraints: budget ≥ MIN_THINKING_BUDGET, budget < max_tokens (raise
 * max_tokens with RESPONSE_HEADROOM, clamp to MAX_TOKENS_CEILING, and if the
 * budget would still meet/exceed max_tokens, shave it to max_tokens - 1).
 *
 * `off` returns no `thinking` key and leaves maxTokens/temperature untouched.
 */
export function anthropicThinkingFor(
  effort: ReasoningEffort,
  maxTokens: number,
): AnthropicThinking {
  if (effort === 'off') {
    return { maxTokens, dropTemperature: false };
  }
  let budget = Math.max(MIN_THINKING_BUDGET, EFFORT_BUDGET_TOKENS[effort]);
  const newMax = Math.min(MAX_TOKENS_CEILING, Math.max(maxTokens, budget + RESPONSE_HEADROOM));
  if (budget >= newMax) {
    budget = newMax - 1;
  }
  return {
    thinking: { type: 'enabled', budget_tokens: budget },
    maxTokens: newMax,
    dropTemperature: true,
  };
}

/**
 * Translate an effort level into the OpenAI `reasoning_effort` value. `off`
 * yields an empty object (nothing to spread); `max` maps to `high` (the OpenAI
 * scale tops out at high).
 */
export function openAiReasoningFor(effort: ReasoningEffort): {
  reasoning_effort?: 'low' | 'medium' | 'high';
} {
  switch (effort) {
    case 'off':
      return {};
    case 'low':
      return { reasoning_effort: 'low' };
    case 'medium':
      return { reasoning_effort: 'medium' };
    case 'high':
    case 'max':
      return { reasoning_effort: 'high' };
  }
}
