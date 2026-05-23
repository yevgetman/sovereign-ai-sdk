// Phase 18 T6 — Unit tests for the streaming translator's tool-use
// branches. Pins the exact wire ordering when the harness emits
// tool_use blocks (carried inside the `assistant_message` StreamEvent)
// and tool_result blocks (carried inside bare user-role Message
// objects yielded by runTools()).
//
// Event-shape contract pinned here (mirrors the comments in
// src/openai/streaming/sseTranslator.ts and the canonical sources
// src/core/query.ts:347 and src/core/orchestrator.ts:115):
//   - `tool_use` blocks: only visible (with resolved `input`) on the
//     terminal `assistant_message` event. The intermediate
//     `tool_use_delta` events carry only partial JSON and are dropped.
//   - `tool_result` blocks: arrive in bare user-role Messages
//     (`{role: 'user', content: [{type: 'tool_result', ...}]}`),
//     distinguished from typed StreamEvents by `role` instead of `type`.
//
// The translator must:
//   1. Emit a single `tool_calls` chunk per assistant_message containing
//      tool_use blocks (D8 — whole arguments JSON in one chunk).
//   2. Suppress assistant_message text content (R2 — already streamed
//      via deltas).
//   3. Emit `event: hermes.tool.progress\ndata: <json>\n\n` for each
//      tool_result block, including `is_error: true` when failures.
//   4. Continue past these events without terminating — the harness's
//      single-request multi-turn surface means more events follow.

import { describe, expect, test } from 'bun:test';
import { translateStream } from '../../../src/openai/streaming/sseTranslator.js';

const ctx = { id: 'chatcmpl-abc', model: 'harness-default', created: 1700000000 };

async function* gen(events: unknown[], terminal: unknown): AsyncGenerator<unknown, unknown, void> {
  for (const ev of events) yield ev;
  return terminal;
}

function collect(): { writer: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    writer: (line) => {
      lines.push(line);
    },
    lines,
  };
}

describe('translateStream — tool_use blocks', () => {
  test('emits a tool_calls chunk for tool_use blocks in assistant_message', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'text_delta', text: 'I will check.' },
          {
            type: 'assistant_message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'I will check.' },
                { type: 'tool_use', id: 'call_1', name: 'FileRead', input: { path: '/x' } },
              ],
            },
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );

    // role + text delta + tool_calls + final stop + DONE = 5 lines.
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('"role":"assistant"');
    expect(lines[1]).toContain('"content":"I will check."');
    expect(lines[2]).toContain('"tool_calls"');
    expect(lines[3]).toContain('"finish_reason":"stop"');
    expect(lines[4]).toBe('data: [DONE]\n\n');

    const toolCallsPayload = JSON.parse(
      (lines[2] ?? '').replace(/^data: /, '').replace(/\n\n$/, ''),
    ) as {
      choices: Array<{
        delta: {
          tool_calls: Array<{
            index: number;
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    expect(toolCallsPayload.choices[0]?.delta.tool_calls[0]).toEqual({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'FileRead', arguments: '{"path":"/x"}' },
    });
  });

  test('suppresses assistant_message text and emits ONLY tool_calls (R2)', async () => {
    // The assistant_message event re-emits the full text content along
    // with the tool_use blocks. R2: the text has already been streamed
    // via text_delta events; re-emitting it would duplicate on the
    // wire. The translator emits ONLY the tool_calls chunk and drops
    // the text portion.
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'text_delta', text: 'streamed' },
          {
            type: 'assistant_message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'streamed' },
                { type: 'tool_use', id: 'call_1', name: 'Tool', input: {} },
              ],
            },
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    // The text 'streamed' appears exactly once (in the delta line).
    const streamedLines = lines.filter((l) => l.includes('"content":"streamed"'));
    expect(streamedLines).toHaveLength(1);
  });

  test('emits tool_calls chunk for tool-only turns (no preceding text_delta)', async () => {
    // The role chunk must still precede the tool_calls chunk — OpenAI
    // clients use `delta.role` to anchor the assistant message.
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            type: 'assistant_message',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_1', name: 'T', input: {} }],
            },
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    // role + tool_calls + final + DONE = 4 lines.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('"role":"assistant"');
    expect(lines[1]).toContain('"tool_calls"');
  });

  test('emits multiple tool_calls in one chunk (parallel calls in same assistant_message)', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            type: 'assistant_message',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'call_a', name: 'A', input: { x: 1 } },
                { type: 'tool_use', id: 'call_b', name: 'B', input: { y: 2 } },
              ],
            },
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const toolCallsLine = lines.find((l) => l.includes('"tool_calls"'));
    expect(toolCallsLine).toBeDefined();
    const payload = JSON.parse(
      (toolCallsLine ?? '').replace(/^data: /, '').replace(/\n\n$/, ''),
    ) as { choices: Array<{ delta: { tool_calls: Array<{ index: number; id: string }> } }> };
    const calls = payload.choices[0]?.delta.tool_calls ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.index).toBe(0);
    expect(calls[1]?.index).toBe(1);
    expect(calls[0]?.id).toBe('call_a');
    expect(calls[1]?.id).toBe('call_b');
  });

  test('does NOT emit a tool_calls chunk when assistant_message has only text', async () => {
    // The text-only assistant_message is the R2 case: its text has
    // already streamed; the translator drops it entirely. No spurious
    // tool_calls chunk should appear.
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'text_delta', text: 'hi' },
          {
            type: 'assistant_message',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'hi' }],
            },
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const toolCallsLines = lines.filter((l) => l.includes('"tool_calls"'));
    expect(toolCallsLines).toHaveLength(0);
  });
});

describe('translateStream — tool_result progress events', () => {
  test('emits hermes.tool.progress event for tool_result in user message', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }],
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const progressLine = lines.find((l) => l.startsWith('event: hermes.tool.progress'));
    expect(progressLine).toBeDefined();
    expect(progressLine).toContain('event: hermes.tool.progress\n');
    expect(progressLine).toContain('data: ');
    expect(progressLine?.endsWith('\n\n')).toBe(true);
    // Extract the data payload.
    const dataLine = progressLine?.split('\n').find((l) => l.startsWith('data: '));
    const payload = JSON.parse((dataLine ?? '').replace(/^data: /, '')) as Record<string, unknown>;
    expect(payload).toEqual({ tool_use_id: 'call_1', output: 'file contents' });
  });

  test('sets is_error: true when tool_result.is_error is true', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: 'permission denied',
                is_error: true,
              },
            ],
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const progressLine = lines.find((l) => l.startsWith('event: hermes.tool.progress'));
    expect(progressLine).toContain('"is_error":true');
  });

  test('omits is_error when false (absence signals success)', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const progressLine = lines.find((l) => l.startsWith('event: hermes.tool.progress'));
    expect(progressLine).not.toContain('is_error');
  });

  test('emits one progress event per tool_result block in a multi-result user message', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_a', content: 'A done' },
              { type: 'tool_result', tool_use_id: 'call_b', content: 'B done' },
            ],
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const progressLines = lines.filter((l) => l.startsWith('event: hermes.tool.progress'));
    expect(progressLines).toHaveLength(2);
    expect(progressLines[0]).toContain('"tool_use_id":"call_a"');
    expect(progressLines[1]).toContain('"tool_use_id":"call_b"');
  });

  test('ignores non-tool_result blocks inside a user message (loop-guidance text)', async () => {
    // query.ts:207-214 can append a text block to the synthesized
    // tool_result user message (the consumeGuidance pattern). The
    // translator must NOT emit a progress event for the text block —
    // only for the tool_result blocks themselves.
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
              { type: 'text', text: 'guidance from loop detector' },
            ],
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    const progressLines = lines.filter((l) => l.startsWith('event: hermes.tool.progress'));
    expect(progressLines).toHaveLength(1);
    expect(progressLines[0]).toContain('"tool_use_id":"call_1"');
  });

  test('does not affect the final stop / DONE close', async () => {
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );
    // progress + final + DONE = 3 lines. (No role chunk: no text deltas
    // and no tool_use to lift the role assertion.)
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('event: hermes.tool.progress');
    expect(lines[1]).toContain('"finish_reason":"stop"');
    expect(lines[2]).toBe('data: [DONE]\n\n');
  });
});

describe('translateStream — multi-turn single-request flow', () => {
  test('full sequence: preamble text + tool_use + tool_result + continuation text', async () => {
    // Mirrors the mock provider's tool-use-mode shape:
    //   call 1: text_delta('Let me ') + text_delta('check.') + assistant_message{tool_use}
    //   runTools: yields user{tool_result}
    //   call 2: text_delta('done.') + assistant_message{text only}
    const { writer, lines } = collect();
    await translateStream(
      gen(
        [
          { type: 'text_delta', text: 'Let me ' },
          { type: 'text_delta', text: 'check.' },
          {
            type: 'assistant_message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Let me check.' },
                {
                  type: 'tool_use',
                  id: 'tu_mock_1',
                  name: 'Bash',
                  input: { command: 'echo hi' },
                },
              ],
            },
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_mock_1', content: 'hi\n' }],
          },
          { type: 'text_delta', text: 'done.' },
          {
            type: 'assistant_message',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done.' }] },
          },
        ],
        { reason: 'completed' },
      ),
      ctx,
      writer,
    );

    // role + 2 text deltas + tool_calls + progress + 1 text delta + final + DONE = 8 lines.
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('"role":"assistant"');
    expect(lines[1]).toContain('"content":"Let me "');
    expect(lines[2]).toContain('"content":"check."');
    expect(lines[3]).toContain('"tool_calls"');
    expect(lines[3]).toContain('"id":"tu_mock_1"');
    expect(lines[4]).toContain('event: hermes.tool.progress');
    expect(lines[4]).toContain('"tool_use_id":"tu_mock_1"');
    expect(lines[5]).toContain('"content":"done."');
    expect(lines[6]).toContain('"finish_reason":"stop"');
    expect(lines[7]).toBe('data: [DONE]\n\n');
  });
});
