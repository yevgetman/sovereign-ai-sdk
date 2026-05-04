// ShareGPT mapping (Phase 13.1). Internal Message → ShareGPT-shaped
// `{from, value}` records suitable for any ShareGPT-compatible training
// loader. Thinking blocks render as `<think>…</think>` for cross-model
// compatibility (OpenAI o-series, Anthropic extended thinking, DeepSeek
// R1 all agree on the tag).
//
// Tool flow renders explicitly: tool_use becomes a "tool_call" line on
// the assistant turn; tool_result becomes a "tool" turn so the trace
// reads naturally as conversation. The fine-tune pipeline can decide
// whether to keep, drop, or restructure tool turns.

import type { ContentBlock, Message } from '../core/types.js';

/** ShareGPT record shape — `from` is the speaker, `value` is the rendered text. */
export type ShareGPTRecord = {
  from: 'system' | 'human' | 'gpt' | 'tool';
  value: string;
};

/** Map a single message into one or more ShareGPT records. The
 *  fine-tune side prefers a flat list of {from, value} records, so
 *  one assistant Message with text + tool_use can split into multiple
 *  records. We keep them in order. */
export function toShareGPT(message: Message): ShareGPTRecord[] {
  if (message.role === 'user') {
    const text = renderUserContent(message.content);
    return text === '' ? [] : [{ from: 'human', value: text }];
  }
  // Assistant: split tool_use blocks out so they're visible as discrete
  // tool calls; tool_result blocks render as 'tool' turns.
  const records: ShareGPTRecord[] = [];
  for (const part of renderAssistantContent(message.content)) {
    records.push(part);
  }
  return records;
}

/** Render an entire transcript. Empty messages drop out. */
export function transcriptToShareGPT(messages: readonly Message[]): ShareGPTRecord[] {
  const out: ShareGPTRecord[] = [];
  for (const m of messages) out.push(...toShareGPT(m));
  return out;
}

function renderUserContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      // tool_result inside a user message is the standard tool-output
      // round-trip. Emit it as a separate 'tool' record? In practice
      // we render the user-side text first, and the tool_result as
      // a sibling 'tool' record via renderAssistantContent on the
      // user side (both work; we choose to render here to avoid an
      // out-of-order extra record from the user message itself).
      const text =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      parts.push(`<tool_result${block.is_error ? ' is_error="true"' : ''}>${text}</tool_result>`);
    } else if (block.type === 'image') {
      parts.push(`<image media_type="${block.source.media_type}" />`);
    }
    // user-side thinking / tool_use: not expected in our internal model;
    // skip rather than mis-render.
  }
  return parts.join('\n').trim();
}

function* renderAssistantContent(blocks: readonly ContentBlock[]): Iterable<ShareGPTRecord> {
  let textBuf = '';
  const flushText = (): ShareGPTRecord | null => {
    const trimmed = textBuf.trim();
    textBuf = '';
    return trimmed === '' ? null : { from: 'gpt', value: trimmed };
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      textBuf += `${textBuf === '' ? '' : '\n'}${block.text}`;
    } else if (block.type === 'thinking') {
      // Thinking renders inline with assistant text inside `<think>` tags
      // so the fine-tune side preserves the reasoning trace.
      textBuf += `${textBuf === '' ? '' : '\n'}<think>\n${block.thinking}\n</think>`;
    } else if (block.type === 'tool_use') {
      const flushed = flushText();
      if (flushed) yield flushed;
      const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
      yield {
        from: 'gpt',
        value: `<tool_call name="${block.name}" id="${block.id}">${input}</tool_call>`,
      };
    } else if (block.type === 'tool_result') {
      const flushed = flushText();
      if (flushed) yield flushed;
      const text =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      yield {
        from: 'tool',
        value: text,
      };
    }
    // image blocks on the assistant side aren't expected in our pipeline; skip.
  }

  const tail = flushText();
  if (tail) yield tail;
}
