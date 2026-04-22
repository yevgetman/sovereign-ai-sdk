// The turn loop — async generator yielding typed events. Phase 0 scaffold:
// signature is locked in, body is minimal. Phase 1 makes the provider call
// actually happen. Phase 2 adds tool-use handling. Phase 10 adds compaction.
//
// Source of pattern: Claude Code src/query.ts (lesson: core loop shape is a
// one-way door; use async generator from day one).

import type { Message, QueryParams, StreamEvent, Terminal } from './types.js';

// biome-ignore lint/correctness/useYield: Phase 0 scaffold — yields come in Phase 1 when the provider call lands.
export async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message, Terminal> {
  // Phase 0: signature only. Provider calls come in Phase 1.
  // The while loop shape is preserved so Phase 2 can slot tool handling in.
  const { provider: _provider, messages: _messages, maxTurns = 5 } = params;
  const turns = 0;
  while (turns < maxTurns) {
    // Phase 1 will:
    //   for await (const event of provider.stream({ ... })) yield event;
    // Phase 2 will:
    //   if (assistant has tool_use) yield* runTools(...); else return completed.
    return { reason: 'completed' };
  }
  return { reason: 'max_turns' };
}
