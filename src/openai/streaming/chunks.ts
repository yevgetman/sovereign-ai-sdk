// Phase 18 T4 — Pure helpers for building OpenAI SSE chunk payloads.
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
// T6 will add `delta.tool_calls` chunks alongside content chunks; the
// builders here only cover the text path.

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
