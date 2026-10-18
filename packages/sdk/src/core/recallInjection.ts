// Recall context splice. Mirrors src/memory/injection.ts: the recalled-lesson
// snapshot is prepended to the latest user message's first text block only;
// the frozen system prompt is never mutated. Immutable — inputs are untouched.
//
// F14: the recalled body is untrusted (a lesson synthesized during a prior,
// possibly poisoned, session). It was previously spliced RAW, so it could close
// a fence and pose as a top-level instruction. It is now wrapped in an outer
// <recall-context> fence and routed through neutralizeFenceBody, which screens
// it (same screen as local context files) and escapes the fence-closing tokens
// — so a legitimately-fenced <learned-context> block is preserved verbatim
// while any breakout stays contained inside the recall fence.

import { neutralizeFenceBody } from '../context/fenceGuard.js';
import type { Message } from './types.js';

/** One recall fence. Empty injection stays empty so a continuation does not invent a block. */
export function prependRecall(text: string, injectionText: string): string {
  if (!injectionText) return text;
  const fenced = `<recall-context>\n${neutralizeFenceBody('recall-context', injectionText)}\n</recall-context>`;
  return `${fenced}\n\n${text}`;
}

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
    content[textIndex] = { type: 'text', text: prependRecall(block.text, injectionText) };
    const out = [...history];
    out[i] = { ...msg, content };
    return out;
  }
  return history;
}
