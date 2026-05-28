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
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import {
  messagesToSdk,
  normalizeAnthropicError,
  systemToSdk,
  translateAnthropicStream,
} from '../../src/providers/anthropic.js';
import { ProviderHttpError } from '../../src/providers/errors.js';

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
