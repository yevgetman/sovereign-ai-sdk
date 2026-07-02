// Anthropic stream-translation fixture test. Feeds a recorded JSONL of raw
// SDK events into translateAnthropicStream() and asserts the internal
// StreamEvent sequence it produces.
//
// No live API calls. No SDK instantiation. The fixture is hand-crafted to
// match the public shape of BetaRawMessageStreamEvent.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import {
  messagesToSdk,
  normalizeAnthropicError,
  systemToSdk,
  translateAnthropicStream,
} from '@yevgetman/sov-sdk/providers/anthropic';
import { ProviderHttpError } from '@yevgetman/sov-sdk/providers/errors';

async function loadFixture(name: string): Promise<RawMessageStreamEvent[]> {
  const path = join(process.cwd(), 'fixtures', name);
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawMessageStreamEvent);
}

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

/** Drain translateAnthropicStream to its returned AssistantMessage. */
async function drainToAssistant(events: RawMessageStreamEvent[]): Promise<AssistantMessage> {
  const gen = translateAnthropicStream(iterate(events));
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

/** Minimal message_start payload — only the fields the translator reads. */
function anthropicMessageStub(): { usage: { input_tokens: number; output_tokens: number } } {
  return { usage: { input_tokens: 7, output_tokens: 0 } };
}

describe('translateAnthropicStream', () => {
  test('hello fixture → matching StreamEvents + assembled AssistantMessage', async () => {
    const rawEvents = await loadFixture('anthropic-stream-hello.jsonl');
    const yielded: StreamEvent[] = [];
    let returned: AssistantMessage | undefined;

    const gen = translateAnthropicStream(iterate(rawEvents));
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        returned = step.value;
        break;
      }
      yielded.push(step.value);
    }

    expect(yielded.map((e) => e.type)).toEqual([
      'message_start',
      'usage_delta',
      'text_delta',
      'text_delta',
      'text_delta',
      'text_delta',
      'usage_delta',
      'message_stop',
      'assistant_message',
    ]);

    const usageEvents = yielded.filter(
      (e): e is Extract<StreamEvent, { type: 'usage_delta' }> => e.type === 'usage_delta',
    );
    expect(usageEvents[0]?.usage.inputTokens).toBe(12);
    expect(usageEvents[1]?.usage.outputTokens).toBe(8);

    const deltas = yielded
      .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text);
    expect(deltas.join('')).toBe('Hello, world!');

    const stop = yielded.find(
      (e): e is Extract<StreamEvent, { type: 'message_stop' }> => e.type === 'message_stop',
    );
    expect(stop?.stop_reason).toBe('end_turn');

    expect(returned).toBeDefined();
    expect(returned?.role).toBe('assistant');
    expect(returned?.content).toEqual([{ type: 'text', text: 'Hello, world!' }]);
  });

  test('handles an empty stream gracefully', async () => {
    const gen = translateAnthropicStream(iterate<RawMessageStreamEvent>([]));
    const collected: StreamEvent[] = [];
    let returned: AssistantMessage | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        returned = step.value;
        break;
      }
      collected.push(step.value);
    }
    // No raw events means no message_stop was seen; the fallback emits
    // message_stop + assistant_message with whatever blocks finalized.
    expect(collected.map((e) => e.type)).toEqual(['message_stop', 'assistant_message']);
    expect(returned?.content).toEqual([]);
  });
});

describe('Anthropic interleaved-thinking signature round-trip', () => {
  // A thinking block emitted by a Claude 4.x model with interleaved thinking on
  // carries a `signature` the API verifies on the tool-result continuation call.
  // The signature must survive stream → internal ContentBlock → SDK replay, or
  // the SECOND provider call of every tool-using turn 400s.
  const thinkingThenToolUse: RawMessageStreamEvent[] = [
    { type: 'message_start', message: anthropicMessageStub() } as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    } as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'let me reason' },
    } as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'SIG-ABC-' },
    } as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'XYZ' },
    } as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'Echo', input: {} },
    } as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
    } as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 1 } as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    } as RawMessageStreamEvent,
    { type: 'message_stop' } as RawMessageStreamEvent,
  ];

  test('finalizeBlock carries the accumulated signature onto the thinking ContentBlock', async () => {
    const returned = await drainToAssistant(thinkingThenToolUse);
    const thinking = returned.content.find(
      (b): b is Extract<typeof b, { type: 'thinking' }> => b.type === 'thinking',
    );
    expect(thinking).toBeDefined();
    expect(thinking?.thinking).toBe('let me reason');
    // The two signature_delta fragments concatenate.
    expect(thinking?.signature).toBe('SIG-ABC-XYZ');
  });

  test('blockToSdk replays the thinking signature verbatim (not the empty string)', async () => {
    const returned = await drainToAssistant(thinkingThenToolUse);
    // Re-send the assistant turn as prior history on the continuation call.
    const sdk = messagesToSdk([returned], false) as unknown as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const thinkingParam = sdk[0]?.content.find((b) => b.type === 'thinking');
    expect(thinkingParam).toBeDefined();
    expect(thinkingParam?.signature).toBe('SIG-ABC-XYZ');
    expect(thinkingParam?.signature).not.toBe('');
  });

  test('redacted_thinking blocks survive stream → ContentBlock → SDK replay', async () => {
    const events: RawMessageStreamEvent[] = [
      { type: 'message_start', message: anthropicMessageStub() } as RawMessageStreamEvent,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'ENCRYPTED-BLOB' },
      } as RawMessageStreamEvent,
      { type: 'content_block_stop', index: 0 } as RawMessageStreamEvent,
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_2', name: 'Echo', input: {} },
      } as RawMessageStreamEvent,
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      } as RawMessageStreamEvent,
      { type: 'content_block_stop', index: 1 } as RawMessageStreamEvent,
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 3 },
      } as RawMessageStreamEvent,
      { type: 'message_stop' } as RawMessageStreamEvent,
    ];
    const returned = await drainToAssistant(events);
    const redacted = returned.content.find(
      (b): b is Extract<typeof b, { type: 'redacted_thinking' }> => b.type === 'redacted_thinking',
    );
    expect(redacted).toBeDefined();
    expect(redacted?.data).toBe('ENCRYPTED-BLOB');

    const sdk = messagesToSdk([returned], false) as unknown as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const redactedParam = sdk[0]?.content.find((b) => b.type === 'redacted_thinking');
    expect(redactedParam).toEqual({ type: 'redacted_thinking', data: 'ENCRYPTED-BLOB' });
  });
});

describe('Anthropic cross-provider thinking-block stripping (#35)', () => {
  // A reasoning-capable OpenAI-API / sov-local / ollama model persists a
  // { type:'thinking' } block with NO signature. When the session later routes
  // to Anthropic (mid-session /model switch, router mix, or resume), replaying
  // that block with the empty-string fallback makes Anthropic 400 with
  // `thinking.signature invalid`. messagesToSdk must drop unsigned thinking
  // blocks while keeping signed (same-provider) ones intact.
  test('drops an unsigned thinking block from outbound Anthropic messages', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'cross-provider reasoning, no sig' },
          { type: 'text', text: 'the answer' },
        ],
      },
    ];
    const sdk = messagesToSdk(history, false) as unknown as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const kinds = sdk[0]?.content.map((b) => b.type);
    expect(kinds).toEqual(['text']);
    expect(sdk[0]?.content.find((b) => b.type === 'thinking')).toBeUndefined();
  });

  test('drops a thinking block whose signature is an empty string', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: '' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const sdk = messagesToSdk(history, false) as unknown as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(sdk[0]?.content.find((b) => b.type === 'thinking')).toBeUndefined();
  });

  test('keeps a signed (same-provider) thinking block', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'signed reasoning', signature: 'SIG-REAL' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const sdk = messagesToSdk(history, false) as unknown as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const thinkingParam = sdk[0]?.content.find((b) => b.type === 'thinking');
    expect(thinkingParam).toBeDefined();
    expect(thinkingParam?.signature).toBe('SIG-REAL');
  });

  test('keeps redacted_thinking blocks (opaque data, no signature)', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'ENCRYPTED' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const sdk = messagesToSdk(history, false) as unknown as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(sdk[0]?.content.find((b) => b.type === 'redacted_thinking')).toEqual({
      type: 'redacted_thinking',
      data: 'ENCRYPTED',
    });
  });
});

describe('Anthropic prompt caching conversion', () => {
  test('marks one cacheable system boundary with ephemeral cache_control', () => {
    const system = systemToSdk([
      { text: 'base', cacheable: true },
      { text: 'tools', cacheable: true },
      { text: 'runtime', cacheable: false },
    ]);
    expect(Array.isArray(system)).toBe(true);
    const blocks = system as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[2]?.cache_control).toBeUndefined();
  });

  test('cache disabled flattens system segments to plain text', () => {
    const system = systemToSdk([{ text: 'base', cacheable: true }], false);
    expect(system).toBe('base');
  });

  test('marks the last three messages when cache is enabled', () => {
    const messages = messagesToSdk([
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'four' }] },
    ]) as unknown as Array<{ content: Array<Record<string, unknown>> }>;

    expect(messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[3]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('does not mark messages when cache is disabled', () => {
    const messages = messagesToSdk(
      [{ role: 'user', content: [{ type: 'text', text: 'one' }] }],
      false,
    ) as unknown as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.cache_control).toBeUndefined();
  });
});

describe('normalizeAnthropicError', () => {
  test('wraps an APIError with a numeric status into ProviderHttpError', () => {
    const apiErr = new Anthropic.APIError(
      429,
      undefined,
      '429 rate limited',
      new Headers({ 'retry-after': '5' }),
    );
    const out = normalizeAnthropicError(apiErr);
    expect(out).toBeInstanceOf(ProviderHttpError);
    expect((out as ProviderHttpError).status).toBe(429);
    expect((out as ProviderHttpError).provider).toBe('anthropic');
    expect((out as ProviderHttpError).message).toContain('rate limited');
  });

  test('wraps a 401 so the resolver can mark the credential auth-failed', () => {
    const apiErr = new Anthropic.APIError(401, undefined, '401 invalid key', new Headers());
    const out = normalizeAnthropicError(apiErr);
    expect(out).toBeInstanceOf(ProviderHttpError);
    expect((out as ProviderHttpError).status).toBe(401);
  });

  test('passes through a ProviderHttpError unchanged', () => {
    const existing = new ProviderHttpError('anthropic', 429, 'already normalized');
    expect(normalizeAnthropicError(existing)).toBe(existing);
  });

  test('passes through a non-API error (e.g. abort/connection) unchanged', () => {
    const plain = new Error('socket hang up');
    expect(normalizeAnthropicError(plain)).toBe(plain);
  });
});
