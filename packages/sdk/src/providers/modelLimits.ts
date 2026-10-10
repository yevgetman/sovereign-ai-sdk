// Request budgets are separate from publisher maxima. Pure, no disk/network.
import { ContextManagementError } from '../compact/contextManagement.js';
import type { Message, SystemSegment } from '../core/types.js';
import type { ToolSchema } from './types.js';

export const UNKNOWN_CONTEXT_TOKENS = 32_768;
export const UNKNOWN_OUTPUT_TOKENS = 8_192;

export type ModelLimitEvidence = {
  contextTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** Stale values may tighten a budget but must not expand the unknown floor. */
  stale?: boolean;
  source?: string;
};
export type EffectiveModelLimits = {
  contextTokens: number;
  outputTokens: number;
  source: string;
};
function positive(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ContextManagementError('model/host limits must be positive safe integers');
  return value;
}
export function resolveModelLimits(
  evidence: ModelLimitEvidence | undefined,
  host: { contextTokens?: number | undefined; outputTokens?: number } = {},
): EffectiveModelLimits {
  const context = positive(evidence?.contextTokens);
  const output = positive(evidence?.outputTokens);
  const hostContext = positive(host.contextTokens);
  const hostOutput = positive(host.outputTokens);
  return {
    contextTokens: Math.min(
      context ?? UNKNOWN_CONTEXT_TOKENS,
      evidence?.stale ? UNKNOWN_CONTEXT_TOKENS : Number.POSITIVE_INFINITY,
      hostContext ?? Number.POSITIVE_INFINITY,
    ),
    outputTokens: Math.min(
      output ?? UNKNOWN_OUTPUT_TOKENS,
      evidence?.stale ? UNKNOWN_OUTPUT_TOKENS : Number.POSITIVE_INFINITY,
      hostOutput ?? Number.POSITIVE_INFINITY,
    ),
    source: evidence?.source ?? 'conservative-unknown',
  };
}

/** UTF-8 bytes provide a deliberately conservative text bound. This is not a
 * tokenizer claim. Image patch accounting differs across models; hosts should
 * supply inputTokenCounter for verified multimodal estimates. Provider overflow
 * recovery remains the final authority when a heuristic is insufficient. */
export function requestInputTokenBound(
  messages: readonly Message[],
  system: readonly SystemSegment[],
  tools: readonly ToolSchema[] = [],
): number {
  return new TextEncoder().encode(JSON.stringify({ messages, system, tools })).byteLength + 256;
}
export function assertRequestFits(
  inputTokens: number,
  outputTokens: number,
  limits: EffectiveModelLimits,
): void {
  positive(inputTokens);
  positive(outputTokens);
  if (outputTokens > limits.outputTokens || inputTokens + outputTokens > limits.contextTokens)
    throw new ContextManagementError(
      'request exceeds effective model limits; reduce context or output reservation',
    );
}
