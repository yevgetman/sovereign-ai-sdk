// OpenAI-compatible transport tests. No live API calls — these exercise
// message/tool conversion and stream-chunk normalization.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { openrouterModelSupportsPromptCaching } from '@yevgetman/sov-sdk/providers/effort';
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

describe('openrouter lane (unified reasoning + usage drift fixes, 2026-08-03)', () => {
  test('sends OpenRouter unified `reasoning` for a curated reasoning model when effort is set', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs({
      model: 'z-ai/glm-5.2',
      system: [],
      messages: [],
      maxTokens: 100,
      effort: 'medium',
    });
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.reasoning_effort).toBeUndefined(); // never the OpenAI dial on this lane
    expect(body.max_tokens).toBe(100); // no max_completion_tokens swap for vendor ids
  });

  // The `off` half of this case CHANGED MEANING on 2026-08-25: `off` on a gated
  // openrouter model is no longer "omit the param" (which let glm-5.2 reason
  // anyway) — it now sends the explicit `{ enabled: false }` disable. Only the
  // non-gated model still keeps a byte-identical body.
  test('non-gated model ⇒ byte-identical body (no reasoning key), at any effort', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const nonReasoning = provider.buildKwargs({
      model: 'moonshotai/kimi-k2.5',
      system: [],
      messages: [],
      maxTokens: 100,
      effort: 'high',
    });
    expect(nonReasoning.reasoning).toBeUndefined();
    const nonReasoningOff = provider.buildKwargs({
      model: 'moonshotai/kimi-k2.5',
      system: [],
      messages: [],
      maxTokens: 100,
      effort: 'off',
    });
    expect(nonReasoningOff.reasoning).toBeUndefined();
  });

  test('effort off on a curated reasoning model ⇒ explicit `reasoning: { enabled: false }`', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs({
      model: 'z-ai/glm-5.2',
      system: [],
      messages: [],
      maxTokens: 100,
      effort: 'off',
    });
    expect(body.reasoning).toEqual({ enabled: false });
    // the disable shape ONLY — an effort dial alongside it would re-enable CoT
    expect(body.reasoning !== undefined && 'effort' in body.reasoning).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
  });

  test('undefined effort ⇒ no reasoning key (byte-identical legacy/preflight path)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs({
      model: 'z-ai/glm-5.2',
      system: [],
      messages: [],
      maxTokens: 100,
    });
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  test('openai proper NEVER gets the unified param (keeps reasoning_effort)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const body = provider.buildKwargs({
      model: 'gpt-5',
      system: [],
      messages: [],
      maxTokens: 100,
      effort: 'high',
    });
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBe('high');
  });

  test('openai proper + off ⇒ unchanged (no unified param, no reasoning_effort)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const body = provider.buildKwargs({
      model: 'gpt-5',
      system: [],
      messages: [],
      maxTokens: 100,
      effort: 'off',
    });
    // o-series/gpt-5 cannot be told not to reason — `off` stays "omit the dial".
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("parses OpenRouter's `delta.reasoning` as thinking (fallback to reasoning_content)", async () => {
    const { yielded, returned } = await drainStream([
      { choices: [{ delta: { reasoning: 'pondering… ' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
    ]);
    expect(yielded).toContainEqual({ type: 'thinking_delta', thinking: 'pondering… ' });
    expect(returned.content[0]).toEqual({ type: 'thinking', thinking: 'pondering… ' });
    expect(returned.content[1]).toEqual({ type: 'text', text: 'answer' });
  });

  test('reasoning_content wins over `reasoning` when a lane emits both (no double count)', async () => {
    const { yielded } = await drainStream([
      { choices: [{ delta: { reasoning_content: 'A', reasoning: 'B' } }] },
    ]);
    const thinks = yielded.filter((e) => e.type === 'thinking_delta');
    expect(thinks).toEqual([{ type: 'thinking_delta', thinking: 'A' }]);
  });

  test('cache_write_tokens maps to the cacheCreation phase in usage_delta', async () => {
    const { yielded } = await drainStream([
      { choices: [{ delta: { content: 'x' } }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 55 },
        },
      },
    ]);
    const usage = yielded.find((e) => e.type === 'usage_delta');
    expect(usage).toEqual({
      type: 'usage_delta',
      usage: {
        inputTokens: 300, // prompt INCLUDES cached → subtracted (disjoint phases)
        outputTokens: 20,
        cacheReadInputTokens: 700,
        cacheCreationInputTokens: 55,
      },
    });
  });
});

describe('openrouter lane: Anthropic prompt caching (2026-08-25)', () => {
  /** The shared request under test: a 3-segment system prompt whose LAST
   *  cacheable segment is the middle one, so a marker on the boundary is
   *  visibly different from "mark the last segment". */
  const CACHEABLE_SYSTEM = [
    { text: 'a', cacheable: true },
    { text: 'b', cacheable: true },
    { text: 'c', cacheable: false },
  ];
  const USER_MESSAGES: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

  function request(overrides: Record<string, unknown> = {}) {
    return {
      model: 'anthropic/claude-sonnet-5',
      system: CACHEABLE_SYSTEM,
      messages: USER_MESSAGES,
      maxTokens: 100,
      ...overrides,
    };
  }

  function countCacheControl(body: unknown): number {
    return JSON.stringify(body).split('"cache_control"').length - 1;
  }

  type WirePart = { type: string; text?: string; cache_control?: unknown };
  type WireMessage = { role: string; content?: string | WirePart[] | null };

  /** The system message's `content` exactly as it goes on the wire, or
   *  `undefined` when no system message was emitted at all. */
  function systemContent(body: unknown): string | WirePart[] | null | undefined {
    const { messages } = JSON.parse(JSON.stringify(body)) as { messages: WireMessage[] };
    return messages.find((m) => m.role === 'system')?.content;
  }

  /** The system content parts; fails loudly if the flat-string shape was emitted. */
  function systemParts(body: unknown): WirePart[] {
    const content = systemContent(body);
    if (!Array.isArray(content)) throw new Error(`expected content parts, got ${typeof content}`);
    return content;
  }

  // TWO parts, not one per segment: the cacheable prefix (through the boundary
  // segment) carries the marker, the volatile remainder follows.
  test('marks the LAST cacheable system segment for an anthropic/* model', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs(request());
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'a\n\nb', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\nc' },
      ],
    });
  });

  test('emits exactly ONE breakpoint for the system message', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    expect(countCacheControl(provider.buildKwargs(request()))).toBe(1);
  });

  test('no cacheable segment ⇒ the plain flattened string (nothing to cache)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs(
      request({
        system: [
          { text: 'a', cacheable: false },
          { text: 'b', cacheable: false },
          { text: 'c', cacheable: false },
        ],
      }),
    );
    expect(body.messages[0]).toEqual({ role: 'system', content: 'a\n\nb\n\nc' });
    expect(countCacheControl(body)).toBe(0);
  });

  // Spec §2.4 — the non-negotiable. The expected string is the body this exact
  // request produced BEFORE the caching change (captured from the pre-change
  // source), pinned as a literal: comparing two calls of the NEW code would
  // pass even if both drifted together.
  const PRE_CHANGE_BODY =
    '{"model":"anthropic/claude-sonnet-5","messages":[{"role":"system","content":"a\\n\\nb\\n\\nc"},' +
    '{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":true},' +
    '"max_tokens":100}';

  test('openai proper ⇒ byte-identical body (the marker is noise there)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    expect(JSON.stringify(provider.buildKwargs(request()))).toBe(PRE_CHANGE_BODY);
  });

  test('a non-Anthropic openrouter model ⇒ byte-identical body (it caches implicitly)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs(request({ model: 'z-ai/glm-5.2' }));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'a\n\nb\n\nc' });
    expect(JSON.stringify(body)).toBe(
      PRE_CHANGE_BODY.replace('anthropic/claude-sonnet-5', 'z-ai/glm-5.2'),
    );
  });

  test('cacheEnabled: false ⇒ byte-identical body (the --no-cache / preflight path)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs(request({ cacheEnabled: false }));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'a\n\nb\n\nc' });
    expect(JSON.stringify(body)).toBe(PRE_CHANGE_BODY);
  });

  test('messagesToOpenAI defaults to no caching (every existing caller unchanged)', () => {
    expect(messagesToOpenAI(USER_MESSAGES, CACHEABLE_SYSTEM)[0]).toEqual({
      role: 'system',
      content: 'a\n\nb\n\nc',
    });
  });

  // THE invariant: caching may change the wire SHAPE, never the prompt TEXT.
  // A drifted prompt is both a behaviour change and a guaranteed cache miss.
  test('part texts concatenate to exactly the flat string the off-path sends', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const mixed = [
      { text: 'stable rules', cacheable: true },
      { text: 'tool catalog\n', cacheable: true }, // trailing newline inside a segment
      { text: 'volatile context', cacheable: false },
      { text: 'the date', cacheable: false },
    ];
    const cached = provider.buildKwargs(request({ system: mixed }));
    const off = provider.buildKwargs(request({ system: mixed, cacheEnabled: false }));

    const flat = systemContent(off);
    // asserts the off-path shape AND narrows it for the equality below
    if (typeof flat !== 'string') throw new Error('expected the off-path to send a flat string');
    expect(
      systemParts(cached)
        .map((part) => part.text ?? '')
        .join(''),
    ).toBe(flat);
    expect(countCacheControl(cached)).toBe(1);
    // and the marker sits on the cacheable prefix, not the volatile tail
    expect(systemParts(cached)[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('an empty trailing segment ⇒ ONE part, marked, with no empty part emitted', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs(
      request({
        system: [
          { text: 'x', cacheable: true },
          { text: '', cacheable: false },
        ],
      }),
    );
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
    });
  });

  test('a whitespace-only system prompt ⇒ no system message (same as caching off)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const system = [{ text: '  ', cacheable: true }];
    expect(systemContent(provider.buildKwargs(request({ system })))).toBeUndefined();
    expect(
      systemContent(provider.buildKwargs(request({ system, cacheEnabled: false }))),
    ).toBeUndefined();
  });

  test('a whitespace-only cacheable prefix ⇒ plain string (nothing worth marking)', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs(
      request({
        system: [
          { text: '  ', cacheable: true },
          { text: 'real', cacheable: false },
        ],
      }),
    );
    expect(body.messages[0]).toEqual({ role: 'system', content: 'real' });
    expect(countCacheControl(body)).toBe(0);
  });

  test('no system segments at all ⇒ no system message', () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-or-test', name: 'openrouter' });
    const body = provider.buildKwargs(request({ system: [] }));
    expect(systemContent(body)).toBeUndefined();
    expect(countCacheControl(body)).toBe(0);
  });

  test('openrouterModelSupportsPromptCaching gates on the anthropic/ vendor prefix', () => {
    expect(openrouterModelSupportsPromptCaching('anthropic/claude-sonnet-5')).toBe(true);
    expect(openrouterModelSupportsPromptCaching('anthropic/claude-opus-4.6')).toBe(true);
    // implicit cachers — a marker buys nothing and would change a working body
    expect(openrouterModelSupportsPromptCaching('z-ai/glm-5.2')).toBe(false);
    expect(openrouterModelSupportsPromptCaching('moonshotai/kimi-k2.7-code')).toBe(false);
    expect(openrouterModelSupportsPromptCaching('openai/gpt-5')).toBe(false);
    // no vendor prefix ⇒ not an openrouter id ⇒ no marker
    expect(openrouterModelSupportsPromptCaching('claude-sonnet-5')).toBe(false);
  });
});
