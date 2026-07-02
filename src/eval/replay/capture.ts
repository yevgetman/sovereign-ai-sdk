// Phase 10.5 part 2b-ii — capture mode. The companion to 2b-i: a
// `CapturingProvider` wraps a real `LLMProvider` and observes every
// StreamEvent on its way through `stream()`; `wrapToolsForCapture`
// wraps tools to record each `call()` outcome. Together they assemble
// a `ReplayFixture` from a live run that can later replay
// deterministically through the 2b-i primitives.
//
// Turn boundaries are driven by the provider — every stream() call
// opens a new turn. Tool results recorded between two stream() calls
// belong to the turn that just closed (which matches the agent loop:
// turn N's tools run after turn N's provider stream and before turn
// N+1's provider stream).

import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { ReplayFixture, ReplayToolResult, ReplayTurn } from './types.js';

export type CaptureMeta = {
  sessionId: string;
  provider: string;
  model: string;
};

/** Mutable accumulator that the capturing wrappers write into. The
 *  eval runner calls `finish()` once the session ends to pull a
 *  finalized fixture out for serialization. */
export type CaptureSink = {
  /** Open a new turn buffer. The next provider events + tool results
   *  belong to this turn. Closes any previous turn first. */
  startTurn(turnIndex: number): void;
  /** Append a provider StreamEvent to the current turn. */
  recordProviderEvent(event: StreamEvent): void;
  /** Append a tool result to the current turn. */
  recordToolResult(result: ReplayToolResult): void;
  /** Close the current turn and freeze a fixture snapshot. Idempotent. */
  finish(): ReplayFixture;
};

/** Build a fresh CaptureSink with the supplied session metadata. The
 *  `capturedAt` timestamp is set lazily at `finish()` time so the
 *  fixture's metadata reflects the session end, not its construction. */
export function createCaptureSink(meta: CaptureMeta): CaptureSink {
  const turns: ReplayTurn[] = [];
  let current: ReplayTurn | null = null;
  let frozen: ReplayFixture | null = null;

  const closeCurrent = () => {
    if (current) turns.push(current);
    current = null;
  };

  return {
    startTurn(turnIndex: number) {
      if (frozen) {
        throw new Error('capture sink already finished — cannot record more events');
      }
      closeCurrent();
      current = { turn: turnIndex, providerEvents: [], toolResults: [] };
    },
    recordProviderEvent(event) {
      if (frozen) {
        throw new Error('capture sink already finished — cannot record more events');
      }
      if (!current) {
        throw new Error(
          'recordProviderEvent called before startTurn — provider event has nowhere to go',
        );
      }
      current.providerEvents.push(event);
    },
    recordToolResult(result) {
      if (frozen) {
        throw new Error('capture sink already finished — cannot record more events');
      }
      if (!current) {
        throw new Error('recordToolResult called before startTurn — tool result has nowhere to go');
      }
      current.toolResults.push(result);
    },
    finish() {
      if (frozen) return frozen;
      closeCurrent();
      frozen = {
        meta: {
          sessionId: meta.sessionId,
          provider: meta.provider,
          model: meta.model,
          capturedAt: new Date().toISOString(),
        },
        turns,
      };
      return frozen;
    },
  };
}

/** LLMProvider wrapper that mirrors every StreamEvent into the sink and
 *  forwards them to the caller unchanged. Each `stream()` call opens a
 *  new turn buffer in the sink; the wrapper preserves the inner
 *  provider's `name` so consumers (REPL banner, audit log) see the real
 *  upstream identity. */
export class CapturingProvider implements LLMProvider {
  readonly name: string;
  private turnCursor = 0;

  constructor(
    private readonly inner: LLMProvider,
    private readonly sink: CaptureSink,
  ) {
    this.name = inner.name;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    this.sink.startTurn(this.turnCursor);
    this.turnCursor++;
    const gen = this.inner.stream(req);
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        return step.value;
      }
      this.sink.recordProviderEvent(step.value);
      yield step.value;
    }
  }

  /** Number of stream() calls observed. Useful for assertions. */
  get turnsObserved(): number {
    return this.turnCursor;
  }
}

/** Wrap each tool's `call()` so that successful results AND thrown
 *  errors are recorded into the sink, keyed by the tool name + the
 *  K-th call to that tool. Counter is per-tool-name and runs across
 *  all turns so it matches `wrapToolsForReplay`'s replay-side scheme. */
export function wrapToolsForCapture(
  baseTools: Tool<unknown, unknown>[],
  sink: CaptureSink,
): Tool<unknown, unknown>[] {
  const counters = new Map<string, number>();
  return baseTools.map((tool) => {
    const wrapped: Tool<unknown, unknown> = {
      ...tool,
      call: async (input: unknown, ctx: ToolContext) => {
        const callIndex = counters.get(tool.name) ?? 0;
        counters.set(tool.name, callIndex + 1);
        try {
          const result = await tool.call(input, ctx);
          sink.recordToolResult({
            toolName: tool.name,
            callIndex,
            data: result.data,
            ...(result.observation ? { observation: result.observation } : {}),
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sink.recordToolResult({
            toolName: tool.name,
            callIndex,
            data: '',
            error: message,
          });
          throw err;
        }
      },
    };
    return wrapped;
  });
}
