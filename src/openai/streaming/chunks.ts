// Phase 18 T4 + T6 — Pure helpers for building OpenAI SSE chunk payloads.
// These are called per text delta, which can be hundreds of times per
// request; the builders allocate one object literal each and do no I/O.
//
// Wire shapes pinned to OpenAI's documented chat.completion.chunk
// format. First chunk by convention carries `delta.role = 'assistant'`,
// subsequent chunks carry only `delta.content`. The final chunk's
// `delta` is empty and the `finish_reason` is non-null. The stream
// terminates with the literal `data: [DONE]\n\n` line — that string
// lives in `DONE_MARKER` so it can be referenced symbolically.
//
// T6 adds:
//   - `buildToolCallsChunk` — emits `delta.tool_calls[]` carrying the
//     whole, already-known arguments JSON in a single chunk (D8: no
//     partial argument streaming).
//   - `buildProgressPayload` — JSON-encodes a hermes.tool.progress
//     side-channel event. The event line (`event: hermes.tool.progress`)
//     is emitted by the translator alongside; this builder owns only the
//     payload portion so the translator stays in charge of wire framing.
//
// Phase 2 T7 adds:
//   - `buildDelegatorProgressPayload` — JSON-encodes a
//     `hermes.delegator.progress` side-channel event. The chat completions
//     streaming branch subscribes to the per-session event bus and writes
//     these events alongside the OpenAI-shaped main stream so external
//     observers can render router progress without parsing the synthetic
//     wire shape. Mirrors `buildProgressPayload`'s framing-free contract:
//     the route owns `event:` / `data:` framing.

import type { TokenUsage } from '@yevgetman/sov-sdk/core/types';
import type {
  DelegatorAtomCompleteEvent,
  DelegatorAtomStartedEvent,
  DelegatorCompleteEvent,
  DelegatorPlanEvent,
} from '../../router/progressEvents.js';

export type ChunkCtx = {
  /** chatcmpl-<sessionId>; same id appears on every chunk in the stream. */
  id: string;
  /** Echo the model name the client requested, not the resolved one. */
  model: string;
  /** Unix epoch seconds; same value for every chunk in the stream. */
  created: number;
};

export type DeltaChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { content?: string; role?: 'assistant' };
    finish_reason: null;
  }>;
};

export type FinalChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: Record<string, never>;
    finish_reason: 'stop' | 'length';
  }>;
};

/** First delta chunk in a stream — emits `delta.role = 'assistant'`
 *  with no content. OpenAI clients (Open WebUI, openai-python SDK)
 *  expect this role assertion at the head of the stream so they can
 *  build the assistant message without re-asserting the role on every
 *  subsequent chunk. */
export function buildRoleChunk(ctx: ChunkCtx): DeltaChunk {
  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
}

/** Content-delta chunk — emits `delta.content = text`. The text may
 *  be an empty string (rare, but valid — some providers emit zero-length
 *  deltas during reasoning passes). */
export function buildDeltaChunk(text: string, ctx: ChunkCtx): DeltaChunk {
  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

/** Terminating delta — empty `delta` object, non-null `finish_reason`.
 *  Reason `'stop'` is normal completion; `'length'` indicates the
 *  underlying model hit `max_tokens` (or the harness's `max_turns`). */
export function buildFinalChunk(reason: 'stop' | 'length', ctx: ChunkCtx): FinalChunk {
  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
}

/** Literal `[DONE]` string. The SSE wire form is `data: [DONE]\n\n`;
 *  this constant carries just the payload portion. */
export const DONE_MARKER = '[DONE]';

/** One element of `delta.tool_calls[]` in an OpenAI chat-completion
 *  chunk. The `index` is the position within the assistant message's
 *  tool_calls array — OpenAI's streaming protocol allows successive
 *  chunks to grow `arguments` per index; the harness emits each call
 *  whole in a single chunk because `query()` has already resolved the
 *  full input by the time the terminal assistant_message arrives. */
export type ToolCallDelta = {
  index: number;
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

/** Chunk variant carrying one or more `tool_calls` deltas. The `delta`
 *  object has no `content` — content and tool_calls are emitted in
 *  separate chunks. `finish_reason` is null because the tool_calls
 *  chunk is not terminal — the harness runs the tools internally and
 *  continues the run (D9: client never sees `finish_reason: 'tool_calls'`). */
export type ToolCallsChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { tool_calls: ToolCallDelta[] };
    finish_reason: null;
  }>;
};

/** Build a single chunk carrying one or more tool_calls. OpenAI's
 *  streaming protocol allows partial argument streaming via successive
 *  chunks (each appending to the same `index`), but D8 emits the whole
 *  arguments JSON in one chunk because the harness already has the full
 *  input by the time we see the tool_use block at the terminal
 *  assistant_message. Indices are 0-based and sequential — they pin the
 *  tool_call position within the assistant message for the client. */
export function buildToolCallsChunk(
  toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  ctx: ChunkCtx,
): ToolCallsChunk {
  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: toolCalls.map((tc, i) => ({
            index: i,
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input ?? {}),
            },
          })),
        },
        finish_reason: null,
      },
    ],
  };
}

/** Payload of a `hermes.tool.progress` SSE side-channel event. The
 *  event line itself (`event: hermes.tool.progress\n`) is emitted by
 *  the translator alongside this payload — keeping framing out of the
 *  builder lets us swap the framing later (named event, JSON-Lines,
 *  WebSocket) without touching the schema.
 *
 *  Field semantics:
 *   - `tool_use_id`: the Anthropic-style id minted by the model. Lets a
 *     downstream observability surface correlate the progress event with
 *     the preceding `tool_calls` chunk that announced the call.
 *   - `output`: the textual result (or error message) the tool produced.
 *     Omitted when there's nothing useful to attach (e.g., a streaming
 *     "started" event in a future expansion).
 *   - `is_error`: true iff the tool returned an error envelope. Omitted
 *     when false — clients should treat absence as "success". */
export type ProgressEvent = {
  tool_use_id: string;
  output?: string;
  is_error?: boolean;
};

/** Build the SSE payload (JSON-encoded) for a hermes.tool.progress
 *  event. Drops `is_error` when false so the wire stays minimal — the
 *  presence of the field signals failure, its absence signals success. */
export function buildProgressPayload(progress: ProgressEvent): string {
  const payload: ProgressEvent = {
    tool_use_id: progress.tool_use_id,
    ...(progress.output !== undefined ? { output: progress.output } : {}),
    ...(progress.is_error === true ? { is_error: true } : {}),
  };
  return JSON.stringify(payload);
}

/** Phase 2 T7 — Payload of a `hermes.delegator.progress` SSE side-channel
 *  event. The event line itself (`event: hermes.delegator.progress\n`) is
 *  emitted by the chat completions streaming branch's bus subscriber; this
 *  builder owns only the payload portion so the wire framing stays in the
 *  route handler.
 *
 *  The four delegator wire-event shapes live in
 *  `src/router/progressEvents.ts` as Zod-derived types — the TUI, `sov
 *  drive`, and this side-channel all re-parse the same JSON envelope.
 *  This builder serializes the event verbatim (no field reshaping) so the
 *  downstream consumers see the same shape they would on the GET /events
 *  SSE wire. */
export type DelegatorProgressEvent =
  | DelegatorPlanEvent
  | DelegatorAtomStartedEvent
  | DelegatorAtomCompleteEvent
  | DelegatorCompleteEvent;

/** Build the SSE payload (JSON-encoded) for a hermes.delegator.progress
 *  event. Verbatim serialization — the event is already the wire shape. */
export function buildDelegatorProgressPayload(event: DelegatorProgressEvent): string {
  return JSON.stringify(event);
}

// ─────────────────────────────────────────────────────────────────────────
// Usage accumulation (shared by the non-streaming route and the streaming
// translator so both transport modes report identical totals).
//
// query() emits one or more `usage_delta` events per provider call: for
// Anthropic, one at message_start (carrying inputTokens + cache fields) and
// one at message_delta (carrying that call's FINAL cumulative outputTokens).
// Both deltas within a single call are cumulative-from-zero FOR THAT CALL, so
// we keep the LAST-SEEN value per field within a call, then SUM those per-call
// finals across the tool loop. A new provider call begins at each
// `message_start`, so we flush the prior call's accumulator there (and once
// more after the generator terminates for the last call).
//
// FIX (#18) — the input total must include cache-read AND cache-creation
// tokens. Anthropic's usageToInternal maps `input_tokens` WITHOUT cached
// tokens (cache_read_input_tokens / cache_creation_input_tokens are separate
// TokenUsage fields). Prompt caching is ON by default, so within a tool loop
// every call after the first is a cache hit — omitting them understates
// prompt_tokens / total_tokens by an order of magnitude. OpenAI semantics
// require prompt_tokens to include cached tokens, and surface the cached
// portion in prompt_tokens_details.cached_tokens.

/** Immutable accumulator state for OpenAI usage reporting. `total*` are the
 *  summed per-call finals; `call*` are the in-progress current call's
 *  last-seen values; `sawAnyCall` gates the first-flush so a zero-call run
 *  stays at 0. */
export type UsageAccumulator = {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedTokens: number;
  readonly callInputTokens: number | undefined;
  readonly callOutputTokens: number | undefined;
  readonly callCachedTokens: number | undefined;
  readonly sawAnyCall: boolean;
};

/** OpenAI `usage` object shape. `prompt_tokens_details.cached_tokens` mirrors
 *  OpenAI's reporting of the cached portion of the prompt. */
export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
};

export function createUsageAccumulator(): UsageAccumulator {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    callInputTokens: undefined,
    callOutputTokens: undefined,
    callCachedTokens: undefined,
    sawAnyCall: false,
  };
}

/** Flush the current call's last-seen per-field values into the running
 *  totals and reset the per-call trackers. Returns a new accumulator. */
function flushCall(acc: UsageAccumulator): UsageAccumulator {
  return {
    ...acc,
    totalInputTokens: acc.totalInputTokens + (acc.callInputTokens ?? 0),
    totalOutputTokens: acc.totalOutputTokens + (acc.callOutputTokens ?? 0),
    totalCachedTokens: acc.totalCachedTokens + (acc.callCachedTokens ?? 0),
    callInputTokens: undefined,
    callOutputTokens: undefined,
    callCachedTokens: undefined,
  };
}

/** Fold one query() event into the accumulator. Returns a new accumulator.
 *  - `message_start` flushes the prior call (a new provider call has begun).
 *  - `usage_delta` records the last-seen value per field for the current call,
 *    including cache-read + cache-creation tokens summed into the call input.
 *  Any other event is a no-op (returns the same state). */
export function accumulateUsageEvent(acc: UsageAccumulator, ev: unknown): UsageAccumulator {
  if (!ev || typeof ev !== 'object' || !('type' in ev)) return acc;
  const type = (ev as { type: unknown }).type;
  if (type === 'message_start') {
    const flushed = acc.sawAnyCall ? flushCall(acc) : acc;
    return { ...flushed, sawAnyCall: true };
  }
  if (type !== 'usage_delta') return acc;
  const usage = (ev as { usage?: TokenUsage }).usage;
  if (!usage || typeof usage !== 'object') return acc;
  const cached = (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const callInput =
    usage.inputTokens !== undefined || cached > 0
      ? (usage.inputTokens ?? 0) + cached
      : acc.callInputTokens;
  return {
    ...acc,
    callInputTokens: callInput,
    callOutputTokens: usage.outputTokens !== undefined ? usage.outputTokens : acc.callOutputTokens,
    callCachedTokens: cached > 0 ? cached : acc.callCachedTokens,
  };
}

/** Flush the final provider call (no trailing message_start closes it) and
 *  project to the OpenAI `usage` object. `prompt_tokens` includes cached
 *  tokens; `prompt_tokens_details.cached_tokens` is emitted only when any
 *  cached tokens were observed. */
export function finalizeUsage(acc: UsageAccumulator): OpenAIUsage {
  const flushed = acc.sawAnyCall ? flushCall(acc) : acc;
  const promptTokens = flushed.totalInputTokens;
  const completionTokens = flushed.totalOutputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(flushed.totalCachedTokens > 0
      ? { prompt_tokens_details: { cached_tokens: flushed.totalCachedTokens } }
      : {}),
  };
}

/** Chunk variant carrying a final `usage` object with an empty `choices`
 *  array — the OpenAI streaming shape when `stream_options.include_usage`
 *  is requested. Emitted just before `[DONE]`. */
export type UsageChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [];
  usage: OpenAIUsage;
};

/** Build the final usage chunk (#38). OpenAI emits this as a standalone
 *  chunk with `choices: []` after the final-stop chunk and before [DONE]. */
export function buildUsageChunk(usage: OpenAIUsage, ctx: ChunkCtx): UsageChunk {
  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [],
    usage,
  };
}
