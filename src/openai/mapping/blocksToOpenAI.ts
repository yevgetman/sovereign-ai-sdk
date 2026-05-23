// Phase 18 T2 — pure mapping: internal ContentBlock[] → OpenAI assistant
// message shape ({ content, tool_calls? }).
//
// Text blocks concatenate into a single `content` string (OpenAI's spec
// treats assistant content as one string; multipart text isn't exposed at
// the response shape). `tool_use` blocks project onto OpenAI's
// `tool_calls` array of function-call objects; the input is JSON-encoded
// to match OpenAI's `arguments: string` convention. Thinking blocks are
// dropped — they're an internal-only reasoning channel.
//
// One spec quirk: when the assistant produced ONLY tool_use blocks (no
// text), OpenAI's response carries `content: null` rather than the empty
// string. Some SDKs strictly type-check this. We mirror that contract
// exactly: if no text blocks contributed, `content` is `null`.

import type { ContentBlock } from '../../core/types.js';

export type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type BlocksToOpenAIResult = {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
};

export function blocksToOpenAI(blocks: ContentBlock[]): BlocksToOpenAIResult {
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  let sawTextBlock = false;
  for (const block of blocks) {
    if (block.type === 'text') {
      sawTextBlock = true;
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
    // thinking, tool_result, image — skipped. tool_result blocks can't
    // appear in assistant content; thinking is internal-only; image
    // blocks don't have a defined OpenAI assistant-output shape.
  }
  // OpenAI spec: content is null when the assistant emitted ONLY
  // tool_calls (no text). Empty string is preserved if a text block was
  // present but empty — the model said "nothing", and the shape distinguishes
  // "no text channel at all" (null) from "deliberate empty text" ('').
  const content = sawTextBlock ? textParts.join('') : toolCalls.length > 0 ? null : '';
  if (toolCalls.length > 0) {
    return { content, tool_calls: toolCalls };
  }
  return { content };
}
