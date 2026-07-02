// Shared test transport wrappers — extracted from individual test files
// once the third caller arrived (per the YAGNI cue left in those files).
//
// Three wrappers live here:
//   1. wrapTransportWithFailingSummarize — throws on the summarize-shaped
//      call (detected by the exact compressionSystemPrompt() text in
//      req.system); passes every other call through. Used by tests that
//      drive the summarizer-failure surface (compact route 500, proactive
//      compaction turn_error). Replaces identical local copies in
//      tests/server/compact.test.ts and tests/server/turns.proactiveCompact
//      .test.ts.
//   2. wrapTransportWithOverflow — factory: throws an overflow-shaped
//      Error on non-summarize main calls when shouldThrow(mainCalls)
//      returns true; everything else passes through. Returns a callCounter
//      so the test can assert exactly how many main vs. summarize calls
//      happened. Replaces tests/server/turns.overflowRecovery.test.ts's
//      local factory + the inlined wrapTransportWithOverflowOnce in
//      tests/cli/tuiLauncherIntegration.test.ts.
//   3. MicrocompactTransport — boundary-aware test transport that detects
//      "iteration 1" via the LAST message containing a tool_result (rather
//      than ANY message — which is what MockProvider's toolUseMode does).
//      Captures every messages[] handed to it via static callMessages so
//      tests can inspect what query() handed the provider on call N.
//      Iteration 0 emits a Bash tool_use; iteration 1 emits "done.".
//      Accepts toolUseId + bashCommand config so the smoke and unit
//      callers can keep their distinct fixture strings. Replaces
//      MicrocompactTestProvider in tests/server/turns.microcompact.test
//      .ts and MicrocompactSmokeTransport in
//      tests/cli/tuiLauncherIntegration.test.ts.

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StreamEvent,
} from '@yevgetman/sov-sdk/core/types';
import type {
  ApiMode,
  ProviderRequest,
  ToolSchema,
  Transport,
} from '@yevgetman/sov-sdk/providers/types';
import { compressionSystemPrompt } from '../../src/compact/compactor.js';

/**
 * Wraps an existing transport so the summarize-shaped call (detected by the
 * exact `compressionSystemPrompt()` text in `req.system`) throws while every
 * other call passes through. Lets tests exercise summarizer-failure surfaces
 * (the /compact route's 500 catch, the proactive-compaction turn_error path)
 * without disturbing any other provider invocation in the same test run.
 */
export function wrapTransportWithFailingSummarize<T extends Transport>(inner: T): T {
  const compressionPrompt = compressionSystemPrompt();
  const wrapped: Transport = {
    name: inner.name,
    apiMode: inner.apiMode,
    toProviderMessages: inner.toProviderMessages.bind(inner),
    toProviderTools: inner.toProviderTools.bind(inner),
    buildKwargs: inner.buildKwargs.bind(inner),
    normalizeResponse: inner.normalizeResponse.bind(inner),
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const isSummarizeCall = req.system.some((seg) => seg.text === compressionPrompt);
      if (isSummarizeCall) {
        throw new Error('mock summarizer failure');
      }
      return yield* inner.stream(req);
    },
  };
  return wrapped as T;
}

/**
 * Factory: wrap a transport so non-summarize stream calls THROW an overflow
 * when `shouldThrow(mainCalls)` returns true, and otherwise pass through to
 * `inner`. Summarize-shaped calls (detected by the exact `compressionSystem
 * Prompt()` text in `req.system`) always pass through so `runtime.compact()`
 * can run normally — only the model's primary calls participate in the throw
 * decision. `mainCalls` is the 1-indexed count of NON-summarize calls so far
 * (incremented BEFORE `shouldThrow` is invoked, so the first main call is
 * `n === 1`).
 *
 * The overflow-detection test in `src/providers/errors.ts:81` is string-based
 * (no `ContextOverflowError` class exists in the codebase), so we throw a
 * plain Error whose message matches one of the substrings checked there
 * (`'context length'`, `'prompt is too long'`, etc.). This is the same shape
 * a real provider's HTTP-413 / OpenAI-style `context_length_exceeded` body
 * would surface as after string-coercion.
 */
export function wrapTransportWithOverflow<T extends Transport>(
  inner: T,
  shouldThrow: (mainCalls: number) => boolean,
): {
  transport: T;
  callCounter: () => { mainCalls: number; summarizeCalls: number };
} {
  const compressionPrompt = compressionSystemPrompt();
  let mainCalls = 0;
  let summarizeCalls = 0;
  const wrapped: Transport = {
    name: inner.name,
    apiMode: inner.apiMode,
    toProviderMessages: inner.toProviderMessages.bind(inner),
    toProviderTools: inner.toProviderTools.bind(inner),
    buildKwargs: inner.buildKwargs.bind(inner),
    normalizeResponse: inner.normalizeResponse.bind(inner),
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const isSummarizeCall = req.system.some((seg) => seg.text === compressionPrompt);
      if (isSummarizeCall) {
        summarizeCalls += 1;
        return yield* inner.stream(req);
      }
      mainCalls += 1;
      if (shouldThrow(mainCalls)) {
        // Surface an overflow. Thrown from inside the async generator, caught
        // at `src/core/query.ts:156-164`, surfaced back to the route via
        // `Terminal { reason: 'error', error }`.
        throw new Error('context length exceeded by 12000 tokens');
      }
      return yield* inner.stream(req);
    },
  };
  return {
    transport: wrapped as T,
    callCounter: () => ({ mainCalls, summarizeCalls }),
  };
}

/** Per-instance message capture for `MicrocompactTransport`. Each instance
 *  records every messages[] handed to it via `stream()` so tests can inspect
 *  what query() forwarded on call N. Per-instance (not static) so concurrent
 *  tests don't trample each other; reset by constructing a fresh instance. */
export type MicrocompactTransportConfig = {
  /** The Anthropic-style tool_use id on iteration 0's tool_use block.
   *  Distinct between callers so test transcripts don't cross-pollinate. */
  toolUseId: string;
  /** The Bash command issued on iteration 0. Visible in the captured
   *  messages array — distinct between callers for the same reason. */
  bashCommand: string;
};

/**
 * Boundary-aware test transport for microcompaction tests. Detects "iteration
 * 1" by inspecting the LAST message for a `tool_result` content block (rather
 * than scanning ALL messages — which is what MockProvider's `toolUseMode`
 * does). This narrower check lets tests SEED prior tool_results into the
 * session history without tripping the continuation branch on the new turn's
 * iteration 0.
 *
 * Iteration 0 emits a Bash `tool_use` so the turn loop reaches the
 * microcompact check after `runTools` ran; iteration 1 emits "done." so the
 * turn terminates cleanly. Captures every `messages[]` array handed to it via
 * `callMessages`, indexed by call order, so tests can assert what query()
 * forwarded on call N (the microcompact signal lives in `callMessages[1]`).
 */
export class MicrocompactTransport implements Transport<Message, ToolSchema, unknown, never> {
  readonly name = 'mock';
  readonly apiMode: ApiMode = 'anthropic';
  readonly toolUseId: string;
  readonly bashCommand: string;

  /** Messages array captured on each `stream()` call, indexed by call order.
   *  Per-instance so concurrent tests don't trample each other. */
  callMessages: Message[][] = [];

  constructor(config: MicrocompactTransportConfig) {
    this.toolUseId = config.toolUseId;
    this.bashCommand = config.bashCommand;
  }

  toProviderMessages(messages: Message[]): Message[] {
    return messages;
  }

  toProviderTools(tools?: ToolSchema[]): ToolSchema[] | undefined {
    return tools;
  }

  buildKwargs(): unknown {
    return {};
  }

  // biome-ignore lint/correctness/useYield: body is an unconditional throw; the AsyncGenerator return-type signature is required by the Transport interface.
  async *normalizeResponse(): AsyncGenerator<StreamEvent, AssistantMessage> {
    throw new Error('normalizeResponse() unused; this transport implements stream() directly.');
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    this.callMessages.push(req.messages);

    const lastMsg = req.messages[req.messages.length - 1];
    const isContinuation =
      lastMsg !== undefined &&
      lastMsg.role === 'user' &&
      lastMsg.content.some((b) => b.type === 'tool_result');

    if (isContinuation) {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'done.' };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      const content: ContentBlock[] = [{ type: 'text', text: 'done.' }];
      const assistant: AssistantMessage = { role: 'assistant', content };
      yield { type: 'assistant_message', message: assistant };
      return assistant;
    }

    const toolInput = { command: this.bashCommand };
    yield { type: 'message_start' };
    yield { type: 'tool_use_delta', id: this.toolUseId, partial: toolInput };
    yield { type: 'message_stop', stop_reason: 'tool_use' };
    const content: ContentBlock[] = [
      { type: 'tool_use', id: this.toolUseId, name: 'Bash', input: toolInput },
    ];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }
}
