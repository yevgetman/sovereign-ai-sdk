// OpenAI-compatible transport tests. No live API calls — these exercise
// message/tool conversion and stream-chunk normalization.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import {
  type OpenAIChatChunk,
  OpenAIProvider,
  messagesToOpenAI,
  parseSse,
  translateOpenAIStream,
} from '@yevgetman/sov-sdk/providers/openai';

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Build a ReadableStream of UTF-8 bytes from a raw SSE wire string. */
function sseBody(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// Drains translateOpenAIStream into its yielded events plus the returned
// AssistantMessage, so tests can assert on both the stream and the final shape.
async function drainStream(
  chunks: OpenAIChatChunk[],
): Promise<{ yielded: StreamEvent[]; returned: AssistantMessage }> {
  const yielded: StreamEvent[] = [];
  const gen = translateOpenAIStream(iterate(chunks));
  for (;;) {
    const step = await gen.next();
    if (step.done) return { yielded, returned: step.value };
    yielded.push(step.value);
  }
}

describe('OpenAIProvider conversion', () => {
  test('flattens system segments and maps tool_use/tool_result blocks', () => {
    const messages = messagesToOpenAI(
      [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I need a file.' },
            { type: 'tool_use', id: 'call_1', name: 'FileRead', input: { path: 'README.md' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'contents' }],
        },
      ],
      [
        { text: 'base', cacheable: true },
        { text: 'context', cacheable: false },
      ],
    );

    expect(messages[0]).toEqual({ role: 'system', content: 'base\n\ncontext' });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'I need a file.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'FileRead', arguments: '{"path":"README.md"}' },
        },
      ],
    });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'contents' });
  });

  test('buildKwargs publishes OpenAI function tools', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const body = provider.buildKwargs({
      model: 'gpt-4o-mini',
      system: [],
      messages: [],
      maxTokens: 100,
      tools: [
        {
          name: 'Echo',
          description: 'echo input',
          input_schema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
    });
    expect(body.tools?.[0]?.function.name).toBe('Echo');
    expect(body.stream).toBe(true);
    // Without this, openai/openrouter stream usage is never reported → $0 cost.
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('parseSse', () => {
  async function collect(raw: string): Promise<OpenAIChatChunk[]> {
    const out: OpenAIChatChunk[] = [];
    for await (const chunk of parseSse(sseBody(raw))) out.push(chunk);
    return out;
  }

  test('parses well-formed data lines and stops at [DONE]', async () => {
    const raw =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n' +
      'data: {"choices":[{"delta":{"content":"!"}}]}\n' +
      'data: [DONE]\n';
    const chunks = await collect(raw);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.choices?.[0]?.delta?.content).toBe('Hi');
  });

  // Polish-pass 2026-07-02 (MEDIUM) — a single malformed data line from a
  // non-conformant OpenAI-compatible endpoint/proxy must NOT abort the turn
  // with a raw SyntaxError. It is skipped; surrounding valid chunks stream.
  test('skips a malformed data line instead of throwing', async () => {
    const raw =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n' +
      'data: {not valid json}\n' +
      'data: {"choices":[{"delta":{"content":"b"}}]}\n' +
      'data: [DONE]\n';
    const chunks = await collect(raw);
    expect(chunks.map((c) => c.choices?.[0]?.delta?.content)).toEqual(['a', 'b']);
  });
});

describe('translateOpenAIStream', () => {
  test('assembles text and streamed tool calls', async () => {
    const chunks: OpenAIChatChunk[] = [
      { choices: [{ delta: { content: 'Hi ' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'Echo', arguments: '{"text"' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];
    const { yielded, returned } = await drainStream(chunks);

    expect(yielded.map((e) => e.type)).toEqual([
      'message_start',
      'text_delta',
      'tool_use_delta',
      'tool_use_delta',
      'message_stop',
      'assistant_message',
    ]);
    expect(returned.content).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'x' } },
    ]);
  });

  test('emits a usage_delta from the final include_usage chunk', async () => {
    const chunks: OpenAIChatChunk[] = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      // Final include_usage chunk: empty choices + top-level usage. The
      // per-choice loop skips it, so usage must be read independently.
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    ];
    const yielded: StreamEvent[] = [];
    const gen = translateOpenAIStream(iterate(chunks));
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      yielded.push(step.value);
    }
    const usage = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'usage_delta' }> => e.type === 'usage_delta',
    );
    expect(usage?.usage.inputTokens).toBe(11);
    expect(usage?.usage.outputTokens).toBe(7);
  });

  // T3 / F6 — phase mapping for OpenAI usage detail objects. OpenAI's
  // prompt_tokens INCLUDES cached tokens; our TokenUsage phase fields must stay
  // DISJOINT + ADDITIVE (input excludes cache reads), so cached_tokens is
  // subtracted from input and surfaced as a separate cacheReadInputTokens phase.
  // reasoning_tokens is an informational SUBSET of output — surfaced, NOT
  // subtracted from outputTokens.
  async function usageOf(chunks: OpenAIChatChunk[]) {
    const { yielded } = await drainStream(chunks);
    return yielded.find(
      (e): e is Extract<StreamEvent, { type: 'usage_delta' }> => e.type === 'usage_delta',
    )?.usage;
  }

  test('maps cached + reasoning details: cache subtracted from input, phase fields surfaced', async () => {
    const usage = await usageOf([
      { choices: [{ delta: { content: 'Hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 400 },
          completion_tokens_details: { reasoning_tokens: 60 },
        },
      },
    ]);
    // input EXCLUDES the 400 cache reads (1000 − 400); cache read is its own phase.
    expect(usage?.inputTokens).toBe(600);
    expect(usage?.cacheReadInputTokens).toBe(400);
    // reasoning is a subset of output — output is unchanged, reasoning surfaced.
    expect(usage?.outputTokens).toBe(200);
    expect(usage?.reasoningTokens).toBe(60);
  });

  test('absent detail objects behave exactly as today (no cache/reasoning fields)', async () => {
    const usage = await usageOf([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    ]);
    expect(usage?.inputTokens).toBe(11);
    expect(usage?.outputTokens).toBe(7);
    expect(usage && 'cacheReadInputTokens' in usage).toBe(false);
    expect(usage && 'reasoningTokens' in usage).toBe(false);
  });

  test('zero cached/reasoning omits the fields (field-absence contract)', async () => {
    const usage = await usageOf([
      { choices: [{ delta: { content: 'x' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    ]);
    // cached_tokens of 0 must not subtract and must not add a field.
    expect(usage?.inputTokens).toBe(50);
    expect(usage?.outputTokens).toBe(8);
    expect(usage && 'cacheReadInputTokens' in usage).toBe(false);
    expect(usage && 'reasoningTokens' in usage).toBe(false);
  });

  test('emits reasoning_content as a thinking stream, not text', async () => {
    const chunks: OpenAIChatChunk[] = [
      { choices: [{ delta: { reasoning_content: 'let me think' } }] },
      { choices: [{ delta: { content: 'the answer is 42' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const { yielded, returned } = await drainStream(chunks);

    // Reasoning surfaces as a distinct thinking_delta carrying that text.
    const thinkingDelta = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'thinking_delta' }> => e.type === 'thinking_delta',
    );
    expect(thinkingDelta?.thinking).toBe('let me think');

    // The final message carries a thinking block with the reasoning text...
    const thinkingBlocks = returned.content.filter(
      (b): b is Extract<typeof b, { type: 'thinking' }> => b.type === 'thinking',
    );
    expect(thinkingBlocks).toEqual([{ type: 'thinking', thinking: 'let me think' }]);

    // ...and the reasoning text never contaminates the content/text channel.
    const textBlocks = returned.content.filter(
      (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
    );
    expect(textBlocks).toEqual([{ type: 'text', text: 'the answer is 42' }]);
    for (const block of textBlocks) expect(block.text).not.toContain('let me think');
  });

  test('orders the thinking block before the text block', async () => {
    const chunks: OpenAIChatChunk[] = [
      { choices: [{ delta: { reasoning_content: 'reasoning' } }] },
      { choices: [{ delta: { content: 'reply' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const { returned } = await drainStream(chunks);

    expect(returned.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'reply' },
    ]);
  });

  test('concatenates reasoning fragmented across chunks (incl. a mixed chunk)', async () => {
    // reasoning_content arrives in pieces, and one chunk carries both reasoning
    // and content — this guards the reasoningParts.join('') assembly.
    const chunks: OpenAIChatChunk[] = [
      { choices: [{ delta: { reasoning_content: 'let ' } }] },
      { choices: [{ delta: { reasoning_content: 'me think' } }] },
      { choices: [{ delta: { reasoning_content: '!', content: 'the ' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ];
    const { yielded, returned } = await drainStream(chunks);

    // The joined thinking block precedes the joined text block.
    expect(returned.content).toEqual([
      { type: 'thinking', thinking: 'let me think!' },
      { type: 'text', text: 'the answer' },
    ]);

    // Each reasoning fragment surfaces as an ordered thinking_delta.
    const thinkingDeltas = yielded
      .filter(
        (e): e is Extract<StreamEvent, { type: 'thinking_delta' }> => e.type === 'thinking_delta',
      )
      .map((e) => e.thinking);
    expect(thinkingDeltas).toEqual(['let ', 'me think', '!']);
  });

  test('preserves an engine-supplied tool-call id (no tool_<index> fallback)', async () => {
    const chunks: OpenAIChatChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc123',
                  type: 'function',
                  function: { name: 'Echo', arguments: '{"text":"x"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];
    const { returned } = await drainStream(chunks);

    const toolUse = returned.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    expect(toolUse?.id).toBe('call_abc123');
    expect(toolUse?.id).not.toBe('tool_0');
  });
});
