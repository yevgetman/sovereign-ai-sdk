// Phase 18 T4 — Streaming translator. Drives a query()-shaped
// AsyncGenerator and emits OpenAI SSE wire-format chunks via the
// `write` callback. Pure function — no I/O, no Hono coupling. The
// route handler (T5) owns the Bun.serve / Hono streamSSE wiring; this
// module just produces the bytes.
//
// Behavior:
//   - Emits a role-only chunk (`{delta: {role: 'assistant'}}`) before
//     the first content delta. OpenAI clients expect the role at the
//     head of the stream; emitting it lazily (on first text_delta)
//     keeps the wire empty for tool-only turns and matches Anthropic's
//     own behavior pattern.
//   - Each `text_delta` event yields a content chunk.
//   - On generator completion, emits a final chunk
//     (`{delta: {}, finish_reason: 'stop' | 'length'}`) followed by
//     `data: [DONE]\n\n`.
//   - The `assistant_message` event (which re-emits the FULL assistant
//     message AFTER streaming) is intentionally dropped — its text
//     has already streamed via deltas. Re-emitting would corrupt the
//     OpenAI wire (R2 in the plan).
//   - `message_stop`, `thinking_delta`, `usage_delta`, `tool_use_delta`,
//     `microcompact`, `loop_detected`, `route_decision`, `message_start`
//     all dropped in T4. T6 will surface `tool_use_delta` and
//     `assistant_message` tool_use blocks via `delta.tool_calls`.
//   - Unknown event types: silently dropped (forward-compatible).
//
// The Terminal value returned by the generator drives the
// `finish_reason`: `'max_tokens' | 'max_turns'` → `'length'`,
// everything else → `'stop'`. Error / interrupted terminals still
// close the wire with `'stop'` — the client sees a (possibly truncated)
// successful response. T5 will decide whether to wrap pre-stream
// errors in an OpenAI error envelope instead.

import type { StreamEvent, Terminal } from '../../core/types.js';
import type { ChunkCtx } from './chunks.js';
import { DONE_MARKER, buildDeltaChunk, buildFinalChunk, buildRoleChunk } from './chunks.js';

export type WriteFn = (line: string) => Promise<void> | void;

/** Drives an AsyncGenerator yielding StreamEvent | Message values and
 *  returning a Terminal. Emits OpenAI-shaped SSE chunks via `write`.
 *  Returns the terminal value so the caller can inspect for error /
 *  interrupted states (e.g. to log, to honor an abort). */
export async function translateStream(
  gen: AsyncGenerator<unknown, unknown, void>,
  ctx: ChunkCtx,
  write: WriteFn,
): Promise<unknown> {
  let terminal: unknown;
  let roleEmitted = false;

  for (;;) {
    const step = await gen.next();
    if (step.done) {
      terminal = step.value;
      break;
    }
    const text = extractTextDelta(step.value);
    if (text === undefined) {
      // Not a text-delta event — skip. T6 will add a tool_use branch.
      continue;
    }
    if (!roleEmitted) {
      await write(`data: ${JSON.stringify(buildRoleChunk(ctx))}\n\n`);
      roleEmitted = true;
    }
    await write(`data: ${JSON.stringify(buildDeltaChunk(text, ctx))}\n\n`);
  }

  const reason = deriveFinishReason(terminal);
  await write(`data: ${JSON.stringify(buildFinalChunk(reason, ctx))}\n\n`);
  await write(`data: ${DONE_MARKER}\n\n`);
  return terminal;
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
