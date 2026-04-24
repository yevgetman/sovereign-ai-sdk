// Anthropic stream-translation fixture test. Feeds a recorded JSONL of raw
// SDK events into translateAnthropicStream() and asserts the internal
// StreamEvent sequence it produces.
//
// No live API calls. No SDK instantiation. The fixture is hand-crafted to
// match the public shape of BetaRawMessageStreamEvent.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import { translateAnthropicStream } from '../../src/providers/anthropic.js';

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
      'text_delta',
      'text_delta',
      'text_delta',
      'text_delta',
      'message_stop',
      'assistant_message',
    ]);

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
