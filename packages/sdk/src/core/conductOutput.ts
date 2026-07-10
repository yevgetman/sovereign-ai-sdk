// packages/sdk/src/core/conductOutput.ts — output-gate substitution helper.
//
// A replace/block verdict substitutes a message's TEXT content while
// preserving tool_use (and thinking) blocks verbatim — replacing tool_use
// blocks would orphan the tool_result blocks already in the transcript
// (Anthropic rejects tool_use without an adjacent matching tool_result).
// The FIRST text block becomes the substituted text; remaining text blocks
// are dropped; non-text blocks keep their positions. A message with no text
// block gains one leading text block.

import type { AssistantMessage } from './types.js';

export function substituteAssistantText(message: AssistantMessage, text: string): AssistantMessage {
  let substituted = false;
  const content: AssistantMessage['content'] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      if (!substituted) {
        content.push({ type: 'text', text });
        substituted = true;
      }
      // subsequent text blocks are dropped
    } else {
      content.push(block);
    }
  }
  if (!substituted) content.unshift({ type: 'text', text });
  return { role: 'assistant', content };
}
