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

/** T12 — one step of a scripted tool-use sequence. The `MockProvider`
 *  walks the script across successive `stream()` calls (one entry per
 *  call). `tool_use` entries emit a single tool_use_delta + assistant
 *  message with a tool_use block (stop_reason='tool_use'). `text`
 *  entries emit a text_delta + assistant message with a text block
 *  (stop_reason='end_turn'). `throw` entries throw an Error on
 *  consumption so atom-failure tests can deterministically inject a
 *  terminal error mid-call-graph without timing tricks. Past the end
 *  of the script the mock falls through to the default Hello-world
 *  behavior so a runaway test never hangs. T13/T14 use this to encode
 *  multi-call sequences (delegator → atom-1 → atom-2 → synthesis →
 *  final) without a real provider; T15 uses `throw` for the
 *  atom-failure integration test. */
export type ToolCallScript =
  | { kind: 'tool_use'; name: string; input: unknown; id?: string }
  | { kind: 'text'; text: string }
  | { kind: 'throw'; message: string };

export class MockProvider implements Transport<Message, ToolSchema, unknown, never> {
  readonly name = 'mock';
  readonly apiMode: ApiMode = 'anthropic';

  /** When true, `stream()` switches to multi-call tool-use behavior. Tests
   *  toggle this around a `try { … } finally { MockProvider.toolUseMode =
   *  false; }` block so the default (single-call, text-only) is restored
   *  for every other test in the suite. */
  static toolUseMode = false;

  /** T12 — when set, `stream()` walks this script one entry per call,
   *  emitting the matching tool_use or text events. Takes precedence over
   *  `toolUseMode` and the default Hello-world path. When the cursor
   *  passes the end of the script, the mock falls back to the default
   *  Hello-world behavior so a misconfigured test never hangs the loop.
   *  Tests MUST reset to `undefined` and call `resetScriptCursor()` in
   *  `afterEach` to avoid cursor leak between tests. T13/T14 use this for
   *  multi-call sequences (delegator → atom-1 → atom-2 → synthesis →
   *  final). */
  static toolUseScript: ToolCallScript[] | undefined = undefined;

  /** Cursor into `toolUseScript`. Bumped on every consumed entry.
   *  Private static so the only sanctioned way to rewind is
   *  `resetScriptCursor()`. */
  private static scriptCursor = 0;

  /** Rewinds the script cursor to zero. Tests MUST call this in
   *  `afterEach` so a leftover cursor from a prior test never bleeds
   *  into the next one. */
  static resetScriptCursor(): void {
    MockProvider.scriptCursor = 0;
  }

  /** M8 T7 — when true, `stream()` emits a Bash tool_use on every call
   *  until the history contains `stallTargetIterations` tool_result blocks.
   *
   *  ux-fixes round 2: each iteration now runs `false` (exit code 1) so
   *  the Bash tool_result carries `is_error: true`. detectStall's
   *  "repeated tool errors with no progress" branch lights up after
   *  three of these in a row. Previously the mock ran `echo` (success)
   *  which the OLD detector flagged via the all-empty branch — that
   *  branch now requires `toolCallCount === 0` so research tool calls
   *  don't trip it. The new failing-command path keeps the integration
   *  test exercising the same downstream wire (stall_detected SSE
   *  event reaches the TUI) while matching the new "tool calls are
   *  progress unless they all fail" semantics.
   *
   *  Default target of 4 makes sure the stall fires (WINDOW=3) before
   *  the mock surrenders; raise it if a future test needs more
   *  iterations. */
  static stallMode = false;
  static stallTargetIterations = 4;

  /** Records the maxTokens value from the last stream() invocation.
   *  Tests reset this to `undefined` before driving a turn to avoid
   *  cross-test leak, then assert the value after draining SSE. */
  static lastMaxTokens: number | undefined = undefined;

  /** Records the `effort` (reasoning-depth) value from the last stream()
   *  invocation. The /effort feature's plumbing tests reset this to
   *  `undefined` before a turn, then assert it is forwarded (when set on
   *  the runtime) or absent (default 'off' / unset). Reset in test finally. */
  static lastEffort: import('./effort.js').ReasoningEffort | undefined = undefined;

  /** Records the `temperature` value from the last stream() invocation.
   *  The OpenAI-compatible server's createAgent re-seat (Task 4.4) tests
   *  reset this to `undefined` before a turn, then assert the client-supplied
   *  `temperature` was forwarded through createAgent → query() → provider
   *  (or absent — the no-temperature default path). Reset in test finally. */
  static lastTemperature: number | undefined = undefined;

  /** Records the `model` id from the last stream() invocation. The gateway
   *  createAgent re-seat (Task 7.1) live-reload test resets this before each
   *  turn, then asserts the model the per-turn `createAgent` ran against
   *  followed a between-turns `/model` swap — i.e. the fresh-per-turn agent
   *  reads the LIVE `runtime.model`. Reset in test finally. */
  static lastModel: string | undefined = undefined;

  /** Snapshot of the `system` (SystemSegment[]) passed to the most recent
   *  `stream()` call. The gateway per-turn `instructions` tests read this to
   *  assert the ephemeral instruction segment was APPENDED to the base system
   *  segments (augment-not-replace) with cacheable:false — and that a turn
   *  WITHOUT instructions received the unchanged base segments. Reset in test
   *  finally. */
  static lastSystem: SystemSegment[] | undefined = undefined;

  /** Counts every `stream()` invocation. Tests use this to verify the
   *  preflight call fired at boot (>= 1 after buildRuntime) or was skipped
   *  (=== 0 when opts.preflight === false). Reset in test finally blocks. */
  static streamCalls = 0;

  /** When true, `stream()` returns an iterable that throws on consumption.
   *  Tests toggle this to deterministically exercise the preflight
   *  failure path without a real network call. Reset in test finally. */
  static preflightShouldFail = false;

  /** Snapshot of the `messages` array passed to the most recent `stream()`
   *  call. Resume tests assert the model received prior conversation
   *  history (M4 regression: turns.ts used to send only the new user
   *  message, defeating the persistence work). Reset in test finally. */
  static lastMessages: Message[] | undefined = undefined;

  /** Snapshot of the `tools` array (as ToolSchema[]) passed to the most
   *  recent `stream()` call. The skill-scope tests (Feature B) read the
   *  tool names off this AFTER a `/skill` turn to assert the live tool pool
   *  query() ran against was narrowed to the skill's allowedTools. Reset in
   *  test finally. */
  static lastTools: ToolSchema[] | undefined = undefined;

  /** Phase 18 T10 — snapshot of the AbortSignal that reached the most
   *  recent `stream()` call. The OpenAI route's abort-bridge test reads
   *  this AFTER triggering an AbortController.abort() on the client
   *  fetch and asserts `lastSignal.aborted === true` to pin that the
   *  client disconnect propagated through Hono → query() → provider.
   *  Reset in test setup/teardown. */
  static lastSignal: AbortSignal | undefined = undefined;

  /** Phase 18 T10 — when true, the `streamHelloWorld` path sleeps for
   *  `slowModeDelayMs` between each yielded event so the SSE stream
   *  stays open long enough for the abort test to fire mid-flight.
   *  Without this the default mock races to completion in a single
   *  microtask tick and the abort lands AFTER the response was already
   *  flushed. Reset in test teardown. */
  static slowMode = false;
  static slowModeDelayMs = 0;

  /** Phase 18 H2 — when set, the next `stream()` invocation throws this
   *  error on first .next() so the calling drain loop sees a provider
   *  failure mid-turn. Used by the non-streaming error-envelope test to
   *  deterministically exercise the catch path without a real network
   *  call. Auto-resets to undefined after one throw so a single test can
   *  configure it and the next mock invocation behaves normally. Reset
   *  in test finally as defense-in-depth. */
  static throwOnNext: Error | undefined = undefined;

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
    MockProvider.streamCalls += 1;
    // Record maxTokens BEFORE any branching so every code path captures it.
    MockProvider.lastMaxTokens = req.maxTokens;
    // Snapshot the reasoning-depth `effort` so the /effort plumbing tests can
    // assert it was forwarded (or omitted) into provider.stream(). `undefined`
    // when the caller omitted the field — the default-off byte-identical path.
    MockProvider.lastEffort = req.effort;
    // Snapshot the `temperature` so the OpenAI createAgent re-seat tests can
    // assert the client-supplied sampling temperature was forwarded (or that
    // an absent temperature stays absent — the byte-identical default path).
    MockProvider.lastTemperature = req.temperature;
    // Snapshot the `model` so the gateway createAgent re-seat (Task 7.1)
    // live-reload test can assert a between-turns model swap reached
    // provider.stream() — proving the per-turn createAgent read runtime.model.
    MockProvider.lastModel = req.model;
    // Snapshot the system segments so the gateway per-turn `instructions` tests
    // can assert the ephemeral instruction was APPENDED to the base segments
    // (augment-not-replace, cacheable:false), or that a turn without it received
    // the unchanged base segments.
    MockProvider.lastSystem = req.system;
    // Snapshot the messages array so resume-history regression tests can
    // assert the model saw prior turns.
    MockProvider.lastMessages = req.messages;
    // Snapshot the tools array so the skill-scope tests (Feature B) can
    // assert the live tool pool query() ran against was narrowed.
    MockProvider.lastTools = req.tools;
    // Phase 18 T10 — snapshot the AbortSignal so abort-propagation tests
    // can assert `lastSignal.aborted === true` after the route bridges
    // a client disconnect through query() into provider.stream().
    MockProvider.lastSignal = req.signal;
    if (MockProvider.preflightShouldFail) {
      // Throw on consumption so preflightProvider's for-await loop sees
      // the failure and classifyProviderPreflightError returns
      // { ok: false, kind: 'unknown', message: ... }. A bare throw inside
      // an async generator fires on the first .next() call, not at the
      // stream() call site itself — exactly the contract preflightProvider
      // expects.
      throw new Error('mock preflight failure');
    }
    if (MockProvider.throwOnNext !== undefined) {
      // H2 — surface a configurable error on this exact invocation so the
      // OpenAI non-streaming error-envelope test can assert the 5xx
      // path. Auto-reset so the next stream() call returns to default
      // behavior; tests still reset in `finally` for safety.
      const err = MockProvider.throwOnNext;
      MockProvider.throwOnNext = undefined;
      throw err;
    }
    if (MockProvider.toolUseScript !== undefined) {
      const entry = MockProvider.toolUseScript[MockProvider.scriptCursor];
      if (entry !== undefined) {
        MockProvider.scriptCursor += 1;
        return yield* this.streamScriptedEntry(entry);
      }
      // Past end of script — fall through to default Hello-world so a
      // misconfigured (too-short) script can't hang the turn loop.
    }
    if (MockProvider.stallMode) {
      return yield* this.streamStall(req);
    }
    if (MockProvider.toolUseMode) {
      return yield* this.streamToolUse(req);
    }
    return yield* this.streamHelloWorld(req.signal);
  }

  /** M8 T7 — emit a Bash tool_use repeatedly until the history carries
   *  `MockProvider.stallTargetIterations` tool_result blocks, then emit
   *  one final text response. Each tool call uses a fresh tool_use id
   *  (suffix = count of existing tool_results) so the orchestrator's
   *  tool_use → tool_result pairing stays well-defined across iterations.
   *
   *  ux-fixes round 2: each iteration runs `false` (exit code 1) so the
   *  Bash tool_result carries `is_error: true`. That trips detectStall's
   *  "onlyErrors" branch (toolCallCount === toolErrorCount and no
   *  edits/memory/decisions for 3 turns). The prior `echo iter-N`
   *  command succeeded and tripped the old "allEmpty" branch; that
   *  branch now requires `toolCallCount === 0` so research-only turns
   *  aren't flagged as stalled. */
  private async *streamStall(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    const iterations = countToolResults(req.messages);
    if (iterations >= MockProvider.stallTargetIterations) {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'stall done.' };
      yield {
        type: 'usage_delta',
        usage: { inputTokens: 0, outputTokens: 2 },
      };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      const content: ContentBlock[] = [{ type: 'text', text: 'stall done.' }];
      const assistant: AssistantMessage = { role: 'assistant', content };
      yield { type: 'assistant_message', message: assistant };
      return assistant;
    }
    const toolId = `mock-stall-${iterations}`;
    // `false` exits with code 1 → isBashError returns true → tool_result
    // carries is_error: true. The unique suffix keeps the iteration count
    // visible in case the test runner ever surfaces tool inputs in logs.
    const toolUseInput = { command: `false # iter-${iterations}` };
    yield { type: 'message_start' };
    yield { type: 'text_delta', text: 'checking.' };
    yield { type: 'tool_use_delta', id: toolId, partial: toolUseInput };
    yield {
      type: 'usage_delta',
      usage: { inputTokens: 0, outputTokens: 5 },
    };
    yield { type: 'message_stop', stop_reason: 'tool_use' };
    const content: ContentBlock[] = [
      { type: 'text', text: 'checking.' },
      { type: 'tool_use', id: toolId, name: 'Bash', input: toolUseInput },
    ];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }

  /** Default behavior — emit "Hello world." in two text deltas then stop.
   *  Preserved verbatim so every existing test that doesn't opt in to
   *  tool-use mode behaves exactly as before.
   *
   *  Phase 18 T10: when `MockProvider.slowMode` is set, each yield is
   *  preceded by an awaited delay so the SSE stream stays open long
   *  enough for client-disconnect tests to abort mid-flight. The delay
   *  respects the AbortSignal — if it fires while we're sleeping we
   *  throw immediately to mimic how a real provider would surface a
   *  cancelled request. */
  private async *streamHelloWorld(
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    await this.maybeDelay(signal);
    yield { type: 'message_start' };
    await this.maybeDelay(signal);
    yield { type: 'text_delta', text: 'Hello' };
    await this.maybeDelay(signal);
    yield { type: 'text_delta', text: ' world.' };
    await this.maybeDelay(signal);
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

  /** Phase 18 T10 — sleep for `slowModeDelayMs` when slowMode is on,
   *  observing the AbortSignal so a fired abort interrupts the wait
   *  immediately. No-op when slowMode is off — every other test path
   *  runs synchronously as before. */
  private async maybeDelay(signal?: AbortSignal): Promise<void> {
    // Test-only env hook (sibling of SOV_TEST_MOCK_PROVIDER): when set, the
    // default Hello-world path sleeps this many ms between events so a real
    // `sov run` subprocess can be interrupted mid-turn by the headless
    // signal-handling integration test. No effect in normal operation.
    const envMs = Number.parseInt(process.env.SOV_TEST_MOCK_SLOW_MS ?? '', 10);
    const delayMs = MockProvider.slowMode
      ? MockProvider.slowModeDelayMs
      : Number.isFinite(envMs) && envMs > 0
        ? envMs
        : 0;
    if (delayMs <= 0) return;
    if (signal?.aborted) {
      throw new DOMException('mock aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('mock aborted', 'AbortError'));
          },
          { once: true },
        );
      }
    });
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

  /** T12 — emit a single scripted entry: either a tool_use call (one
   *  tool_use_delta + assistant message carrying the tool_use block,
   *  stop_reason='tool_use') or a text response (one text_delta +
   *  assistant message carrying a text block, stop_reason='end_turn').
   *  The shapes mirror the existing `toolUseMode` / `streamHelloWorld`
   *  paths exactly so downstream (`query()` + the orchestrator + the
   *  SSE bridge) consumes them without special-casing.
   *
   *  T15 — `throw` entries throw an Error as the very first generator
   *  step so the AgentRunner's `for await` surfaces it as a terminal
   *  failure. The scheduler catches the throw and returns an
   *  `interrupted` terminal with the error message embedded in the
   *  child summary; the parent's tool_result wraps it accordingly. */
  private async *streamScriptedEntry(
    entry: ToolCallScript,
  ): AsyncGenerator<StreamEvent, AssistantMessage> {
    if (entry.kind === 'throw') {
      // Throw BEFORE yielding any events so the consumer sees the
      // failure on the very first .next() call — same shape as the
      // `preflightShouldFail` path and as any real provider error
      // raised before the first stream chunk lands.
      throw new Error(entry.message);
    }
    yield { type: 'message_start' };
    if (entry.kind === 'tool_use') {
      const toolId = entry.id ?? `mock-script-${MockProvider.scriptCursor - 1}`;
      yield { type: 'tool_use_delta', id: toolId, partial: entry.input };
      yield {
        type: 'usage_delta',
        usage: { inputTokens: 0, outputTokens: 1 },
      };
      yield { type: 'message_stop', stop_reason: 'tool_use' };
      const content: ContentBlock[] = [
        { type: 'tool_use', id: toolId, name: entry.name, input: entry.input },
      ];
      const assistant: AssistantMessage = { role: 'assistant', content };
      yield { type: 'assistant_message', message: assistant };
      return assistant;
    }
    // entry.kind === 'text'
    yield { type: 'text_delta', text: entry.text };
    yield {
      type: 'usage_delta',
      usage: { inputTokens: 0, outputTokens: 1 },
    };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    const content: ContentBlock[] = [{ type: 'text', text: entry.text }];
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

/** M8 T7 — count tool_result content blocks across all user messages.
 *  Used by `streamStall` to gate when the mock provider transitions from
 *  emitting more tool_use blocks into the final text response. */
function countToolResults(messages: Message[]): number {
  let n = 0;
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') n += 1;
    }
  }
  return n;
}
