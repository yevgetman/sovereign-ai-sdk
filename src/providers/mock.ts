// Mock provider for tests and the M3 first-turn smoke. Implements the
// `Transport` shape resolveProvider() returns: a deterministic synthetic
// turn — one text message ("Hello world.") — with no network call. Used
// when `name === 'mock'` or `SOV_TEST_MOCK_PROVIDER=1`.
//
// Phase 16.1 M3: the foreground (TUI/server) needs an end-to-end turn
// without API credentials so smoke tests and CI runs are reliable. The
// model and StreamEvent shape match exactly what `query()` already
// consumes so no special-casing is needed downstream.
//
// Phase 16.1 M3 (post-fix): a tool-use mode is gated on
// `MockProvider.toolUseMode = true`. In that mode the first model call
// emits a preamble + a tool_use block targeting `BashTool` with an
// `echo`; the second model call emits a one-line "done." response.
// This exercises the multi-call path so we can assert the
// `tool_use_start` / `tool_use_done` / `tool_result` wire sequence
// without hitting a real provider. The detector for "this is the
// continuation call" is the presence of a `tool_result` block anywhere
// in the request's message history — that's a signal `query()` ran the
// tool and is asking for the next model turn. Tests set the toggle
// before driving a turn and reset it in `finally`.

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StreamEvent,
  SystemSegment,
} from '../core/types.js';
import type { ApiMode, ProviderRequest, ToolSchema, Transport } from './types.js';

/** Deterministic synthetic tool_use id used by the tool-use-mode call 1.
 *  Stable across calls so call 2's tool_result message (synthesized by
 *  the orchestrator) carries the same id back into the assistant turn. */
const MOCK_TOOL_USE_ID = 'mock-tool-use-0';

export class MockProvider implements Transport<Message, ToolSchema, unknown, never> {
  readonly name = 'mock';
  readonly apiMode: ApiMode = 'anthropic';

  /** When true, `stream()` switches to multi-call tool-use behavior. Tests
   *  toggle this around a `try { … } finally { MockProvider.toolUseMode =
   *  false; }` block so the default (single-call, text-only) is restored
   *  for every other test in the suite. */
  static toolUseMode = false;

  /** Records the maxTokens value from the last stream() invocation.
   *  Tests reset this to `undefined` before driving a turn to avoid
   *  cross-test leak, then assert the value after draining SSE. */
  static lastMaxTokens: number | undefined = undefined;

  /** Counts every `stream()` invocation. Tests use this to verify the
   *  preflight call fired at boot. Note: this is incremented on every
   *  call, not just preflight — the name is a misnomer kept for clarity
   *  in the Phase 16.1 M4 Task 6 tests where it pins "at least one
   *  preflight call happened" (>= 1). Reset in test finally blocks. */
  static preflightCalls = 0;

  /** When true, `stream()` returns an iterable that throws on consumption.
   *  Tests toggle this to deterministically exercise the preflight
   *  failure path without a real network call. Reset in test finally. */
  static preflightShouldFail = false;

  toProviderMessages(messages: Message[], _system?: SystemSegment[]): Message[] {
    return messages;
  }

  toProviderTools(tools?: ToolSchema[]): ToolSchema[] | undefined {
    return tools;
  }

  buildKwargs(_req: ProviderRequest): unknown {
    return {};
  }

  // Required by the Transport interface but never invoked. The mock
  // implements the streaming path via stream(); the non-streaming
  // response handling is not supported here. The previous body cast
  // `{} as ProviderRequest` and produced a plausible-looking but
  // dishonest delegate call.
  // biome-ignore lint/correctness/useYield: body is an unconditional throw; the AsyncGenerator return-type signature is required by the Transport interface.
  async *normalizeResponse(
    _raw: AsyncIterable<never>,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    throw new Error(
      'normalizeResponse() should never be called on MockProvider. The mock implements the Transport interface for the stream() path only; non-streaming response handling is not supported.',
    );
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    // Count every invocation BEFORE any branching. T6 tests assert the
    // preflight call fired (>= 1). Other code paths may bump this too —
    // the test wording is "at least one preflight call happened".
    MockProvider.preflightCalls += 1;
    // Record maxTokens BEFORE any branching so every code path captures it.
    MockProvider.lastMaxTokens = req.maxTokens;
    if (MockProvider.preflightShouldFail) {
      // Throw on consumption so preflightProvider's for-await loop sees
      // the failure and classifyProviderPreflightError returns
      // { ok: false, kind: 'unknown', message: ... }. A bare throw inside
      // an async generator fires on the first .next() call, not at the
      // stream() call site itself — exactly the contract preflightProvider
      // expects.
      throw new Error('mock preflight failure');
    }
    if (MockProvider.toolUseMode) {
      return yield* this.streamToolUse(req);
    }
    return yield* this.streamHelloWorld();
  }

  /** Default behavior — emit "Hello world." in two text deltas then stop.
   *  Preserved verbatim so every existing test that doesn't opt in to
   *  tool-use mode behaves exactly as before. */
  private async *streamHelloWorld(): AsyncGenerator<StreamEvent, AssistantMessage> {
    yield { type: 'message_start' };
    yield { type: 'text_delta', text: 'Hello' };
    yield { type: 'text_delta', text: ' world.' };
    yield {
      type: 'usage_delta',
      usage: { inputTokens: 0, outputTokens: 2 },
    };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    const content: ContentBlock[] = [{ type: 'text', text: 'Hello world.' }];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }

  /** Tool-use mode — two-call sequence:
   *   call 1 (no prior tool_result in history): preamble text + tool_use →
   *     `Bash({ command: "echo hello-from-mock" })` with stop_reason='tool_use'
   *   call 2 (history contains a tool_result): "done." text + stop_reason='end_turn'
   *  `query()` consumes call 1, dispatches the tool via runTools, then
   *  re-enters with the resulting tool_result user message in history. */
  private async *streamToolUse(
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    const continuation = hasToolResult(req.messages);
    if (continuation) {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'done.' };
      yield {
        type: 'usage_delta',
        usage: { inputTokens: 0, outputTokens: 1 },
      };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      const content: ContentBlock[] = [{ type: 'text', text: 'done.' }];
      const assistant: AssistantMessage = { role: 'assistant', content };
      yield { type: 'assistant_message', message: assistant };
      return assistant;
    }

    yield { type: 'message_start' };
    yield { type: 'text_delta', text: 'Let me ' };
    yield { type: 'text_delta', text: 'check.' };
    const toolUseInput = { command: 'echo hello-from-mock' };
    yield { type: 'tool_use_delta', id: MOCK_TOOL_USE_ID, partial: toolUseInput };
    yield {
      type: 'usage_delta',
      usage: { inputTokens: 0, outputTokens: 5 },
    };
    yield { type: 'message_stop', stop_reason: 'tool_use' };
    const content: ContentBlock[] = [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: MOCK_TOOL_USE_ID, name: 'Bash', input: toolUseInput },
    ];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }
}

/** True iff any message in `history` has a `tool_result` content block.
 *  Used by tool-use mode to detect whether this is the continuation call.
 *  Looking at the message-shape directly avoids needing a static counter
 *  on the class — keeps tool-use mode purely a function of request state. */
function hasToolResult(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') return true;
    }
  }
  return false;
}
