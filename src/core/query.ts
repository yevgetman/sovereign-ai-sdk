// The turn loop — async generator yielding typed events. Phase 1: a single
// turn. Stream provider events through verbatim, capture the assistant
// message, return `completed` when there's no tool_use. Phase 2 will wrap
// this in a while-loop that splices tool execution and continuation turns
// between streams.
//
// Source of pattern: Claude Code src/query.ts (lesson: core loop shape is a
// one-way door; use async generator from day one).

import type { AssistantMessage, Message, QueryParams, StreamEvent, Terminal } from './types.js';

export async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message, Terminal> {
  const { provider, model, messages, systemPrompt, maxTokens, temperature, signal } = params;
  // maxTurns is reserved for Phase 2 (tool-use continuation). Unused in Phase 1.

  if (signal?.aborted) return { reason: 'interrupted' };

  let assistant: AssistantMessage | undefined;

  try {
    for await (const event of provider.stream({
      model,
      system: systemPrompt,
      messages,
      maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'assistant_message') {
        assistant = event.message;
      }
      yield event;
    }
  } catch (err) {
    if (signal?.aborted) return { reason: 'interrupted' };
    return { reason: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (!assistant) {
    return {
      reason: 'error',
      error: new Error('provider stream ended without an assistant_message'),
    };
  }

  const hasToolUse = assistant.content.some((b) => b.type === 'tool_use');
  if (hasToolUse) {
    // Phase 2 will execute the tools and loop back for a continuation turn.
    // Phase 1 bails explicitly so a surprise tool_use doesn't silently stall.
    return {
      reason: 'error',
      error: new Error('tool_use encountered but Phase 2 tool handling not yet implemented'),
    };
  }

  return { reason: 'completed' };
}
