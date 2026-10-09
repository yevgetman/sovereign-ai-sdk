// Host-injected context reduction. No summarizer or proprietary implementation.
import type { Message, TokenUsage } from '../core/types.js';

export type ContextLimits = {
  /** UTF-8 JSON history bytes, excluding system/tools. Not a token estimate. */
  maxHistoryBytes: number;
  /** Host-supplied model limit, passed through to the summarizer. */
  contextWindowTokens?: number;
  /** Hard bounded overflow recovery; default one, supported values zero/one. */
  maxOverflowRetries?: 0 | 1;
};
export type ContextManagementRequest = {
  messages: readonly Message[];
  reason: 'budget' | 'overflow';
  model: string;
  provider: string;
  maxTokens: number;
  limits: ContextLimits;
  signal: AbortSignal;
  sessionId?: string;
};
export type ContextManagementResult = {
  messages: Message[];
  /** Summary-engine usage, not the main provider's cumulative usage. */
  usage?: TokenUsage;
  /** Host's estimate for this reduction; absent means unknown. */
  estimatedCostUsd?: number;
};
export interface ContextManagementPort {
  /** Must honor signal and settle before returning. No fire-and-forget work. */
  reduce(request: ContextManagementRequest): Promise<ContextManagementResult>;
}
export type ContextManagementInfo = {
  applied: boolean;
  reason: ContextManagementRequest['reason'];
  beforeBytes: number;
  afterBytes: number;
  usage?: TokenUsage;
  estimatedCostUsd?: number;
};
export class ContextManagementError extends Error {
  constructor(
    message: string,
    readonly info?: ContextManagementInfo,
  ) {
    super(message);
    this.name = 'ContextManagementError';
  }
}
export function historyBytes(messages: readonly Message[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
}
export function validateContextLimits(limits: ContextLimits): void {
  if (
    !Number.isSafeInteger(limits.maxHistoryBytes) ||
    limits.maxHistoryBytes < 1 ||
    (limits.contextWindowTokens !== undefined &&
      (!Number.isSafeInteger(limits.contextWindowTokens) || limits.contextWindowTokens < 1)) ||
    (limits.maxOverflowRetries !== undefined &&
      limits.maxOverflowRetries !== 0 &&
      limits.maxOverflowRetries !== 1)
  ) {
    throw new ContextManagementError('invalid context limits');
  }
}
function validateHistory(messages: Message[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ContextManagementError('replacement context is empty');
  }
  let pending = new Set<string>();
  const seen = new Set<string>();
  let hasText = false;
  for (const message of messages) {
    if (
      !message ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      !Array.isArray(message.content) ||
      message.content.length === 0
    ) {
      throw new ContextManagementError('invalid context message');
    }
    let messageHasContent = false;
    const expected = pending;
    pending = new Set();
    for (const block of message.content) {
      if (!block || typeof block !== 'object')
        throw new ContextManagementError('invalid context block');
      if (block.type === 'text') {
        if (typeof block.text !== 'string')
          throw new ContextManagementError('invalid context text');
        messageHasContent ||= block.text.trim().length > 0;
        hasText ||= block.text.trim().length > 0;
      } else if (block.type === 'tool_use') {
        if (
          message.role !== 'assistant' ||
          typeof block.id !== 'string' ||
          !block.id ||
          typeof block.name !== 'string' ||
          !block.name ||
          seen.has(block.id) ||
          block.input === undefined
        )
          throw new ContextManagementError('invalid context tool call');
        messageHasContent = true;
        seen.add(block.id);
        pending.add(block.id);
      } else if (block.type === 'tool_result') {
        if (
          message.role !== 'user' ||
          typeof block.content !== 'string' ||
          !expected.delete(block.tool_use_id)
        )
          throw new ContextManagementError('orphan context tool result');
        messageHasContent = true;
      } else if (block.type === 'thinking') {
        if (typeof block.thinking !== 'string')
          throw new ContextManagementError('invalid thinking block');
        messageHasContent ||= block.thinking.trim().length > 0;
      } else if (block.type === 'redacted_thinking') {
        if (typeof block.data !== 'string')
          throw new ContextManagementError('invalid redacted thinking');
        messageHasContent ||= block.data.trim().length > 0;
      } else if (block.type === 'image') {
        if (
          block.source?.type !== 'base64' ||
          typeof block.source.data !== 'string' ||
          typeof block.source.media_type !== 'string'
        )
          throw new ContextManagementError('invalid image');
        messageHasContent ||= block.source.data.length > 0;
      } else throw new ContextManagementError('unknown context block');
    }
    if (!messageHasContent) throw new ContextManagementError('empty context message');
    if (expected.size) throw new ContextManagementError('context tool adjacency is broken');
  }
  if (pending.size) throw new ContextManagementError('context ends with unresolved tool calls');
  if (!hasText) throw new ContextManagementError('replacement context has no text');
}
export async function reduceContext(
  port: ContextManagementPort,
  request: ContextManagementRequest,
): Promise<{ messages: Message[]; info: ContextManagementInfo }> {
  validateContextLimits(request.limits);
  request.signal.throwIfAborted();
  // Snapshot protects live model history against accidental port mutations.
  const before = JSON.stringify(request.messages);
  const limits = { ...request.limits };
  const result = await port.reduce({
    ...request,
    limits: { ...limits },
    messages: JSON.parse(before) as Message[],
  });
  if (!result || typeof result !== 'object')
    throw new ContextManagementError('invalid reduction result');
  // Validate billing metadata before trusting it in either success or failure events.
  if (
    result.usage !== undefined &&
    (!result.usage ||
      typeof result.usage !== 'object' ||
      Object.values(result.usage).some(
        (v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0,
      ))
  ) {
    throw new ContextManagementError('invalid reduction usage');
  }
  if (
    result.estimatedCostUsd !== undefined &&
    (!Number.isFinite(result.estimatedCostUsd) || result.estimatedCostUsd < 0)
  ) {
    throw new ContextManagementError('invalid reduction cost');
  }
  let afterBytes = 0;
  const beforeBytes = new TextEncoder().encode(before).byteLength;
  try {
    // A cancelled reduction still owes its validated bill, but cannot change history.
    request.signal.throwIfAborted();
    validateHistory(result.messages);
    afterBytes = historyBytes(result.messages);
    if (
      afterBytes >= beforeBytes ||
      (request.reason === 'budget' && afterBytes > limits.maxHistoryBytes)
    ) {
      throw new ContextManagementError('replacement context did not fit or shrink');
    }
    const original = JSON.parse(before) as Message[];
    if (JSON.stringify(result.messages.at(-1)) !== JSON.stringify(original.at(-1))) {
      throw new ContextManagementError('replacement changed the latest message');
    }
  } catch (error) {
    throw new ContextManagementError(error instanceof Error ? error.message : 'invalid reduction', {
      applied: false,
      reason: request.reason,
      beforeBytes: new TextEncoder().encode(before).byteLength,
      afterBytes: new TextEncoder().encode(before).byteLength,
      ...(result.usage !== undefined ? { usage: { ...result.usage } } : {}),
      ...(result.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: result.estimatedCostUsd }
        : {}),
    });
  }
  return {
    messages: structuredClone(result.messages),
    info: {
      applied: true,
      reason: request.reason,
      beforeBytes,
      afterBytes,
      ...(result.usage !== undefined ? { usage: { ...result.usage } } : {}),
      ...(result.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: result.estimatedCostUsd }
        : {}),
    },
  };
}
