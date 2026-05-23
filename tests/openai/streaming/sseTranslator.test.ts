// Phase 18 T4 — Unit tests for the streaming translator. Pins the
// exact line sequence emitted to the `write` callback so we catch any
// regression in head/middle/tail wire ordering.

import { describe, expect, test } from 'bun:test';
import { translateStream } from '../../../src/openai/streaming/sseTranslator.js';

const ctx = { id: 'chatcmpl-abc', model: 'harness-default', created: 1700000000 };

/** Helper — yields the given events in order, then returns the given
 *  terminal value. Mimics the shape of `query()`'s AsyncGenerator. */
async function* gen(events: unknown[], terminal: unknown): AsyncGenerator<unknown, unknown, void> {
  for (const ev of events) yield ev;
  return terminal;
}

/** Returns a write callback that captures every line into `lines`. */
function collect(): { writer: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    writer: (line) => {
      lines.push(line);
    },
    lines,
  };
}

describe('translateStream', () => {
  test('emits exactly role chunk + N content chunks + final stop + DONE', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'text_delta', text: 'Hel' },
          { type: 'text_delta', text: 'lo' },
          { type: 'text_delta', text: ' world.' },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    // role + 3 deltas + final + DONE = 6 lines.
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('"role":"assistant"');
    expect(lines[1]).toContain('"content":"Hel"');
    expect(lines[2]).toContain('"content":"lo"');
    expect(lines[3]).toContain('"content":" world."');
    expect(lines[4]).toContain('"finish_reason":"stop"');
    expect(lines[5]).toBe('data: [DONE]\n\n');
  });

  test('every chunk line is prefixed with "data: " and ends with double newline', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen([{ type: 'text_delta', text: 'x' }], { reason: 'completed' }),
      ctx,
      writer,
    );
    for (const line of lines) {
      expect(line.startsWith('data: ')).toBe(true);
      expect(line.endsWith('\n\n')).toBe(true);
    }
  });

  test('omits role chunk when there are no text deltas', async () => {
    const { writer, lines } = collect();
    await translateStream(gen([], { reason: 'completed' }), ctx, writer);
    // Only the final chunk + DONE — no role chunk to head an empty stream.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"finish_reason":"stop"');
    expect(lines[1]).toBe('data: [DONE]\n\n');
  });

  test('role chunk emits exactly once even with many text deltas', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        Array.from({ length: 5 }, (_, i) => ({ type: 'text_delta', text: `t${i}` })),
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const roleLines = lines.filter((l) => l.includes('"role":"assistant"'));
    expect(roleLines).toHaveLength(1);
    expect(lines[0]).toBe(roleLines[0]);
  });

  test('derives finish_reason: length when terminal.reason is max_tokens', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen([{ type: 'text_delta', text: 'x' }], { reason: 'max_tokens' }),
      ctx,
      writer,
    );
    // Final chunk is the second-to-last line; last line is `[DONE]`.
    const finalLine = lines[lines.length - 2];
    expect(finalLine).toContain('"finish_reason":"length"');
  });

  test('derives finish_reason: length when terminal.reason is max_turns', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen([{ type: 'text_delta', text: 'x' }], { reason: 'max_turns' }),
      ctx,
      writer,
    );
    const finalLine = lines[lines.length - 2];
    expect(finalLine).toContain('"finish_reason":"length"');
  });

  test('error / interrupted terminals still close with finish_reason: stop', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen([{ type: 'text_delta', text: 'partial' }], { reason: 'error' }),
      ctx,
      writer,
    );
    const finalLine = lines[lines.length - 2];
    expect(finalLine).toContain('"finish_reason":"stop"');
  });

  test('drops unknown / out-of-scope event types without crashing', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'message_start' }, // dropped
          { type: 'thinking_delta', thinking: 'reasoning...' }, // dropped
          { type: 'text_delta', text: 'visible' },
          { type: 'usage_delta', usage: { outputTokens: 7 } }, // dropped
          { type: 'message_stop', stop_reason: 'end_turn' }, // dropped — terminal handles finish
          { type: 'tool_use_delta', id: 'tu_1', partial: {} }, // dropped in T4 (T6 surfaces)
          { type: 'made_up_event' }, // dropped — forward-compatible
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    // role + 1 content + final + DONE = 4 lines.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('"content":"visible"');
  });

  test('suppresses assistant_message text (already streamed via deltas)', async () => {
    // R2 — translator must IGNORE assistant_message text. The text has
    // already been streamed; re-emitting would duplicate it on the wire.
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'text_delta', text: 'streamed' },
          {
            type: 'assistant_message',
            message: { role: 'assistant', content: [{ type: 'text', text: 'streamed' }] },
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    // role + 1 content + final + DONE = 4 lines; assistant_message dropped.
    expect(lines).toHaveLength(4);
    // The streamed text appears exactly once (in line 1).
    const contentLines = lines.filter((l) => l.includes('"content":"streamed"'));
    expect(contentLines).toHaveLength(1);
  });

  test('returns the terminal value to the caller', async () => {
    const { writer } = collect();
    const result = await translateStream(
      gen([], { reason: 'completed', toolCallCount: 0 }),
      ctx,
      writer,
    );
    expect(result).toEqual({ reason: 'completed', toolCallCount: 0 });
  });

  test('accepts an async write callback (awaits between lines)', async () => {
    const lines: string[] = [];
    const writer = async (line: string): Promise<void> => {
      // Simulate an async backpressure-aware sink.
      await Promise.resolve();
      lines.push(line);
    };
    await translateStream(
      gen([{ type: 'text_delta', text: 'a' }], { reason: 'completed' }),
      ctx,
      writer,
    );
    // role + 1 content + final + DONE = 4.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('"role":"assistant"');
    expect(lines[3]).toBe('data: [DONE]\n\n');
  });

  test('treats text_delta with a non-string text field as not-a-delta', async () => {
    // Forward-defensive — if a future event slips through with the
    // right `type` but a malformed payload, the translator skips it
    // rather than crashing.
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'text_delta', text: null }, // dropped (defensive)
          { type: 'text_delta', text: 'real' },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    // role + 1 content + final + DONE = 4 lines.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('"content":"real"');
  });

  test('handles a missing terminal value (generator returns undefined)', async () => {
    const { writer, lines } = collect();
    const result = await translateStream(gen([], undefined), ctx, writer);
    // Final chunk + DONE — finish_reason defaults to 'stop'.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"finish_reason":"stop"');
    expect(result).toBeUndefined();
  });
});
