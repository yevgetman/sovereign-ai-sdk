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

export type RequestInputTokenEstimate = {
  tokens: number;
  /** False means image-token costs still require a host counter or provider validation. */
  complete: boolean;
  uncountedImages: number;
};

/** Conservative text/framing bound. Image data and remote references are
 * transport representations, not model text tokens. No generic image-token
 * allowance is asserted: hosts may supply a verified model-aware counter;
 * otherwise provider validation/overflow recovery remains authoritative. */
export function requestInputTokenEstimate(
  messages: readonly Message[],
  system: readonly SystemSegment[],
  tools: readonly ToolSchema[] = [],
): RequestInputTokenEstimate {
  let uncountedImages = 0;
  const textMessages = messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'image') return block;
      uncountedImages++;
      // Keep framing in the bound without turning encoded bytes/URLs into text.
      return { type: 'image' };
    }),
  }));
  return {
    tokens:
      new TextEncoder().encode(JSON.stringify({ messages: textMessages, system, tools }))
        .byteLength + 256,
    complete: uncountedImages === 0,
    uncountedImages,
  };
}

/** Compatibility numeric helper. For image requests this bounds text/framing
 * only; use requestInputTokenEstimate to retain the completeness signal. */
export function requestInputTokenBound(
  messages: readonly Message[],
  system: readonly SystemSegment[],
  tools: readonly ToolSchema[] = [],
): number {
  return requestInputTokenEstimate(messages, system, tools).tokens;
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
