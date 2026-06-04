// Recall context splice. Mirrors src/memory/injection.ts: the recalled-lesson
// snapshot is prepended to the latest user message's first text block only;
// the frozen system prompt is never mutated. Immutable — inputs are untouched.

import type { Message } from './types.js';

export function injectRecallIntoLatestUserMessage(
  history: Message[],
  injectionText: string,
): Message[] {
  if (!injectionText) return history;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== 'user') continue;
    const textIndex = msg.content.findIndex((block) => block.type === 'text');
    const block = msg.content[textIndex];
    if (!block || block.type !== 'text') return history;
    const content = [...msg.content];
    content[textIndex] = { type: 'text', text: `${injectionText}\n\n${block.text}` };
    const out = [...history];
    out[i] = { ...msg, content };
    return out;
  }
  return history;
}
