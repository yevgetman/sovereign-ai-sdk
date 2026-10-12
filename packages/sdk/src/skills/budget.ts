// Shared metadata/guidance budgets. Feed the turn's frozen effective limits,
// never a model ID or an ambient provider table. UTF-8 bytes bound text tokens.
import { UNKNOWN_CONTEXT_TOKENS } from '../providers/modelLimits.js';

export type SkillContextBudget = {
  contextWindowTokens: number;
  source: 'known' | 'fallback';
  availableTokens: number;
  indexTokens: number;
  pageTokens: number;
  retentionTokens: number;
};

export function resolveSkillContextBudget(
  options: {
    contextWindowTokens?: number;
    outputTokens?: number;
    reservedInputTokens?: number;
  } = {},
): SkillContextBudget {
  const known =
    Number.isSafeInteger(options.contextWindowTokens) && (options.contextWindowTokens ?? 0) > 0;
  const contextWindowTokens = known
    ? (options.contextWindowTokens ?? UNKNOWN_CONTEXT_TOKENS)
    : UNKNOWN_CONTEXT_TOKENS;
  for (const value of [options.outputTokens, options.reservedInputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error('skill context reservations must be nonnegative safe integers');
  }
  const reserved = (options.outputTokens ?? 0) + (options.reservedInputTokens ?? 0);
  // Reserve task/standing-guidance headroom even when the host has no counter.
  const availableTokens = Math.max(
    0,
    contextWindowTokens - reserved - Math.ceil(contextWindowTokens * 0.1),
  );
  return {
    contextWindowTokens,
    source: known ? 'known' : 'fallback',
    availableTokens,
    indexTokens: Math.min(2_048, Math.floor(availableTokens * 0.01)),
    pageTokens: Math.min(1_024, Math.floor(availableTokens * 0.02)),
    retentionTokens: Math.min(8_192, Math.floor(availableTokens * 0.04)),
  };
}

export function skillTextTokenBound(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function clipSkillText(text: string, byteLimit: number): { text: string; clipped: boolean } {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 0)
    throw new Error('skill text byte limit must be a nonnegative safe integer');
  if (skillTextTokenBound(text) <= byteLimit) return { text, clipped: false };
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = skillTextTokenBound(char);
    if (bytes + size > byteLimit) break;
    out += char;
    bytes += size;
  }
  return { text: out, clipped: true };
}
