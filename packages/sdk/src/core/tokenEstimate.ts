// Cheap token estimation for context-window decisions. Deliberately rough:
// about four characters per token plus small structural overheads.

import type { ContentBlock, Message, SystemSegment } from './types.js';

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD_TOKENS = 8;
const MESSAGE_OVERHEAD_TOKENS = 12;
const SYSTEM_SEGMENT_OVERHEAD_TOKENS = 12;

export function estimateTextTokens(text: string): number {
  // Defensive: `text` is TYPED `string`, but the ContentBlock fields it reads
  // (tool_result content, thinking, image source data, …) can be a non-string
  // at RUNTIME — a consumer that rehydrates a session or replays a real
  // Anthropic transcript carries wire shapes TS has erased. A non-string must
  // yield a rough estimate, never a `.length` TypeError that aborts the turn.
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function estimateJsonTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return estimateTextTokens(String(value));
  }
}

export function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === 'text') return BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.text);
  if (block.type === 'thinking') {
    return BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.thinking);
  }
  if (block.type === 'tool_use') {
    return (
      BLOCK_OVERHEAD_TOKENS +
      estimateTextTokens(block.id) +
      estimateTextTokens(block.name) +
      estimateJsonTokens(block.input)
    );
  }
  if (block.type === 'tool_result') {
    // `content` is TYPED `string`, but a rehydrated/replayed session can carry a
    // non-string wire shape — an ARRAY of content blocks (image / structured
    // results) or a MISSING body. This estimator runs FIRST on the compaction
    // gate (shouldMicrocompact → estimateBlockTokens) BEFORE the compact-path
    // guards, so it must tolerate the non-string case itself (F9 sibling).
    // estimateJsonTokens coerces any value to a bounded estimate (0 for
    // null/undefined, JSON length otherwise) without throwing.
    return (
      BLOCK_OVERHEAD_TOKENS +
      estimateTextTokens(block.tool_use_id) +
      (typeof block.content === 'string'
        ? estimateTextTokens(block.content)
        : estimateJsonTokens(block.content))
    );
  }
  if (block.type === 'redacted_thinking') {
    return BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.data);
  }
  return (
    BLOCK_OVERHEAD_TOKENS +
    estimateTextTokens(block.source.media_type) +
    estimateTextTokens(block.source.data)
  );
}

export function estimateMessageTokens(message: Message): number {
  return (
    MESSAGE_OVERHEAD_TOKENS +
    estimateTextTokens(message.role) +
    message.content.reduce((total, block) => total + estimateBlockTokens(block), 0)
  );
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function estimateSystemPromptTokens(systemPrompt: readonly SystemSegment[]): number {
  return systemPrompt.reduce(
    (total, segment) =>
      total +
      SYSTEM_SEGMENT_OVERHEAD_TOKENS +
      estimateTextTokens(segment.text) +
      estimateTextTokens(segment.cacheable ? 'cacheable' : 'uncached'),
    0,
  );
}
