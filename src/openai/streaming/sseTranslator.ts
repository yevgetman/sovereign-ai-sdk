// Phase 18 T4 + T6 — Streaming translator. Drives a query()-shaped
// AsyncGenerator and emits OpenAI SSE wire-format chunks via the
// `write` callback. Pure function — no I/O, no Hono coupling. The
// route handler (T5) owns the Bun.serve / Hono streamSSE wiring; this
// module just produces the bytes.
//
// Behavior:
//   - Emits a role-only chunk (`{delta: {role: 'assistant'}}`) before
//     the first content delta. OpenAI clients expect the role at the
//     head of the stream; emitting it lazily (on first text_delta or
//     first tool_use) keeps the wire empty for completely-empty turns
//     and matches Anthropic's own behavior pattern.
//   - Each `text_delta` event yields a content chunk.
//   - The `assistant_message` event (which re-emits the FULL assistant
//     message AFTER streaming) has its TEXT dropped — text has already
//     streamed via deltas (R2 in the plan). T6 walks the same event's
//     `tool_use` blocks and emits them as a `tool_calls` chunk: the
//     terminal `assistant_message` is the only place tool_use blocks
//     are visible with their resolved `input` (the intermediate
//     `tool_use_delta` events carry only partial JSON).
//   - User-role Messages (yielded by query() after runTools) carry the
//     `tool_result` blocks for tool calls executed within the same
//     request. The translator emits each as a `event: hermes.tool.progress`
//     side-channel SSE event so observability surfaces can see the
//     execution outcome — clients of the chat-completion wire never
//     have to handle these (D9: harness runs tools internally; client
//     never sees `finish_reason: 'tool_calls'`).
//   - On generator completion, emits a final chunk
//     (`{delta: {}, finish_reason: 'stop' | 'length'}`) followed by
//     `data: [DONE]\n\n`.
//   - `message_stop`, `thinking_delta`, `usage_delta`, `tool_use_delta`,
//     `microcompact`, `loop_detected`, `route_decision`, `message_start`
//     all dropped — they have no OpenAI-wire analogue and the relevant
//     state (tool inputs, finish reason, completion) flows via the
//     paths above.
//   - Unknown event types: silently dropped (forward-compatible).
//
// Event-shape note: `query()` yields a *union* of typed StreamEvents
// (`{type: ...}`) and bare Message objects (`{role: 'user' | 'assistant', content: [...]}`).
// Tool_use BLOCKS arrive inside the typed `assistant_message` StreamEvent's
// `.message.content`. Tool_result BLOCKS arrive inside bare user-role
// Message objects yielded directly by `runTools()` (see
// src/core/orchestrator.ts:115 and src/core/query.ts:347). The role
// discriminator is what tells them apart from StreamEvents.
//
// The Terminal value returned by the generator drives the
// `finish_reason`: `'max_tokens' | 'max_turns'` → `'length'`,
// everything else → `'stop'`. Error / interrupted terminals still
// close the wire with `'stop'` — the client sees a (possibly truncated)
// successful response. T5 wraps pre-stream errors in an OpenAI error
// envelope; in-stream errors fall through to the final-stop+DONE close.

import type { ContentBlock, StreamEvent, Terminal } from '../../core/types.js';
import type { ChunkCtx, UsageAccumulator } from './chunks.js';
import {
  DONE_MARKER,
  accumulateUsageEvent,
  buildDeltaChunk,
  buildFinalChunk,
  buildProgressPayload,
  buildRoleChunk,
  buildToolCallsChunk,
  buildUsageChunk,
  createUsageAccumulator,
  finalizeUsage,
} from './chunks.js';

export type WriteFn = (line: string) => Promise<void> | void;

/** Options for the translator. `includeUsage` (#38) mirrors OpenAI's
 *  `stream_options.include_usage`: when true, a final usage chunk
 *  (choices: []) is emitted just before [DONE], reporting the same
 *  accumulated totals as the non-streaming branch. */
export type TranslateStreamOptions = {
  includeUsage?: boolean;
};

/** Drives an AsyncGenerator yielding StreamEvent | Message values and
 *  returning a Terminal. Emits OpenAI-shaped SSE chunks via `write`.
 *  Returns the terminal value so the caller can inspect for error /
 *  interrupted states (e.g. to log, to honor an abort). */
export async function translateStream(
  gen: AsyncGenerator<unknown, unknown, void>,
  ctx: ChunkCtx,
  write: WriteFn,
  options: TranslateStreamOptions = {},
): Promise<unknown> {
  let terminal: unknown;
  let roleEmitted = false;
  // #38 — accumulate usage across the tool loop so we can emit a final usage
  // chunk (parity with the non-streaming branch). Folded for every event
  // regardless of includeUsage; the chunk is only written when requested.
  let usageAcc: UsageAccumulator = createUsageAccumulator();

  const ensureRoleEmitted = async (): Promise<void> => {
    if (roleEmitted) return;
    await write(`data: ${JSON.stringify(buildRoleChunk(ctx))}\n\n`);
    roleEmitted = true;
  };

  for (;;) {
    const step = await gen.next();
    if (step.done) {
      terminal = step.value;
      break;
    }
    const ev = step.value;
    usageAcc = accumulateUsageEvent(usageAcc, ev);

    // Bare Message objects (role-discriminated): user-role messages
    // carry tool_result blocks; assistant-role messages are never
    // yielded as bare Messages in the current query() flow (assistant
    // content always arrives via the `assistant_message` StreamEvent).
    // Treat any future assistant-role bare Message as a no-op — the
    // text path is owned by `text_delta`, the tool_use path by
    // `assistant_message`.
    if (isUserMessage(ev)) {
      await emitToolProgressFromUserMessage(ev, write);
      continue;
    }

    // Typed StreamEvent: assistant_message carries the resolved
    // tool_use blocks (T6). Text deltas continue to flow via the
    // `text_delta` branch below.
    if (isAssistantMessageEvent(ev)) {
      await emitToolCallsFromAssistantMessage(ev, ctx, write, ensureRoleEmitted);
      continue;
    }

    const text = extractTextDelta(ev);
    if (text === undefined) {
      // Not a text-delta event — skip. Unknown types fall through
      // silently for forward compatibility.
      continue;
    }
    await ensureRoleEmitted();
    await write(`data: ${JSON.stringify(buildDeltaChunk(text, ctx))}\n\n`);
  }

  const reason = deriveFinishReason(terminal);
  await write(`data: ${JSON.stringify(buildFinalChunk(reason, ctx))}\n\n`);
  // #38 — emit the usage chunk (choices: []) BEFORE [DONE] when the client
  // requested stream_options.include_usage.
  if (options.includeUsage === true) {
    await write(`data: ${JSON.stringify(buildUsageChunk(finalizeUsage(usageAcc), ctx))}\n\n`);
  }
  await write(`data: ${DONE_MARKER}\n\n`);
  return terminal;
}

/** Type guard for typed StreamEvent of kind `assistant_message`. The
 *  underlying shape is `{type: 'assistant_message', message: AssistantMessage}`;
 *  the message's `content` is `ContentBlock[]` containing the resolved
 *  tool_use blocks (with full `input`) along with any text. */
function isAssistantMessageEvent(
  ev: unknown,
): ev is { type: 'assistant_message'; message: { content: ContentBlock[] } } {
  if (!ev || typeof ev !== 'object') return false;
  const t = (ev as { type?: unknown }).type;
  if (t !== 'assistant_message') return false;
  const msg = (ev as { message?: unknown }).message;
  if (!msg || typeof msg !== 'object') return false;
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content);
}

/** Type guard for a bare user-role Message yielded by query() (the
 *  tool_result envelope returned by runTools). Distinguished from typed
 *  StreamEvents by carrying `role` instead of `type`. */
function isUserMessage(ev: unknown): ev is { role: 'user'; content: ContentBlock[] } {
  if (!ev || typeof ev !== 'object') return false;
  const r = (ev as { role?: unknown }).role;
  if (r !== 'user') return false;
  const content = (ev as { content?: unknown }).content;
  return Array.isArray(content);
}

/** Walk an assistant_message event's content for tool_use blocks and
 *  emit a single `tool_calls` chunk carrying them all. Text blocks are
 *  ignored — their content has already been streamed via `text_delta`
 *  events (R2). Empty tool_use lists are no-ops (text-only turn). */
async function emitToolCallsFromAssistantMessage(
  ev: { type: 'assistant_message'; message: { content: ContentBlock[] } },
  ctx: ChunkCtx,
  write: WriteFn,
  ensureRoleEmitted: () => Promise<void>,
): Promise<void> {
  const toolUses = ev.message.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b && b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  if (toolUses.length === 0) return;
  // OpenAI clients expect the role assertion to precede tool_calls
  // chunks just as it precedes content chunks — pin it here too in
  // case the turn is tool-only (no preceding text_delta).
  await ensureRoleEmitted();
  await write(`data: ${JSON.stringify(buildToolCallsChunk(toolUses, ctx))}\n\n`);
}

/** Walk a user-role Message's content for tool_result blocks and emit
 *  one `event: hermes.tool.progress` SSE event per result. Non-result
 *  blocks (e.g., loop-detector guidance text appended to a tool_result
 *  message — see query.ts:207-214) are ignored.
 *
 *  Tool_result block content is canonically a string in the harness's
 *  internal ContentBlock union (src/core/types.ts:14). Stringification
 *  is defensive: a future shape change to structured content (text +
 *  image arrays) would slip through narrowing — we coerce to JSON so
 *  the wire stays well-formed regardless. */
async function emitToolProgressFromUserMessage(
  msg: { role: 'user'; content: ContentBlock[] },
  write: WriteFn,
): Promise<void> {
  for (const block of msg.content) {
    if (!block || block.type !== 'tool_result') continue;
    const payload = buildProgressPayload({
      tool_use_id: block.tool_use_id,
      output: normalizeToolResultContent(block.content),
      ...(block.is_error === true ? { is_error: true } : {}),
    });
    await write(`event: hermes.tool.progress\ndata: ${payload}\n\n`);
  }
}

/** Normalize a tool_result's `content` field to a string for the wire.
 *  Internal canonical shape is `string` (see ContentBlock union), but
 *  defensive coercion guards against future structured-content drift. */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/** Returns the text payload if `ev` is a text_delta StreamEvent, else
 *  undefined. The harness's internal StreamEvent uses the flat shape
 *  `{type: 'text_delta', text: string}` (see src/core/types.ts) — no
 *  nested content_block_delta form is emitted by query(). */
function extractTextDelta(ev: unknown): string | undefined {
  if (!ev || typeof ev !== 'object') return undefined;
  const typed = ev as Partial<StreamEvent>;
  if (typed.type !== 'text_delta') return undefined;
  // After narrowing on type='text_delta', TS still wants us to confirm
  // `text` is a string (the union discriminator doesn't propagate
  // through Partial<>). The narrowing is cheap and forward-defensive
  // against a malformed event slipping through.
  if (typeof (typed as { text?: unknown }).text !== 'string') return undefined;
  return (typed as { text: string }).text;
}

/** Maps a Terminal's reason → OpenAI finish_reason. `max_tokens` and
 *  `max_turns` are both surfaced as `'length'`; everything else
 *  (completed, error, interrupted, checkin) collapses to `'stop'`. T5
 *  will decide whether pre-stream errors warrant a JSON error envelope
 *  instead of a partial SSE stream. */
function deriveFinishReason(terminal: unknown): 'stop' | 'length' {
  if (!terminal || typeof terminal !== 'object') return 'stop';
  const reason = (terminal as Partial<Terminal>).reason;
  if (reason === 'max_tokens' || reason === 'max_turns') return 'length';
  return 'stop';
}
