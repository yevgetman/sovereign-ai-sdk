// Phase 10.5 part 2b — ReplayProvider. Implements LLMProvider by
// re-emitting captured StreamEvents one turn at a time. Drop-in
// replacement for the real provider when running a session against a
// fixture — the agent loop, orchestrator, permissions, hooks, MCP wiring,
// and trace writer all run unchanged. Only the provider boundary is
// stubbed.

import type { AssistantMessage, StreamEvent } from '../../core/types.js';
import type { LLMProvider, ProviderRequest } from '../../providers/types.js';
import type { ReplayFixture } from './types.js';

export type ReplayProviderOpts = {
  fixture: ReplayFixture;
  /** Override the surfaced `name` (default: 'replay'). Useful when a
   *  consumer (REPL banner, audit log) needs to think it's running
   *  against a specific provider. */
  providerName?: string;
};

export class ReplayProvider implements LLMProvider {
  readonly name: string;
  private turnCursor = 0;
  constructor(private readonly opts: ReplayProviderOpts) {
    this.name = opts.providerName ?? 'replay';
  }

  /** Re-emit the captured StreamEvents for the next turn. Throws when
   *  the agent makes more turns than were captured (a divergence — the
   *  test should fail loud rather than silently produce incomplete
   *  output). */
  async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const turn = this.opts.fixture.turns[this.turnCursor];
    if (!turn) {
      throw new Error(
        `replay exhausted: agent requested turn ${this.turnCursor} but fixture only captured ${this.opts.fixture.turns.length}`,
      );
    }
    this.turnCursor++;
    let assistant: AssistantMessage | undefined;
    for (const event of turn.providerEvents) {
      if (event.type === 'assistant_message') assistant = event.message;
      yield event;
    }
    if (!assistant) {
      throw new Error(
        `replay turn ${turn.turn} ended without an assistant_message — fixture is malformed`,
      );
    }
    return assistant;
  }

  /** How many turns have been streamed so far. Useful for tests
   *  asserting the agent stopped at the right point. */
  get turnsConsumed(): number {
    return this.turnCursor;
  }

  /** True when every captured turn has been re-emitted. */
  get isExhausted(): boolean {
    return this.turnCursor >= this.opts.fixture.turns.length;
  }
}
