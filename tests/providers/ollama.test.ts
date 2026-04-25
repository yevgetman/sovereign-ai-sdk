// Ollama transport tests. No live Ollama daemon required.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import {
  type OllamaChatChunk,
  OllamaProvider,
  translateOllamaStream,
} from '../../src/providers/ollama.js';

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('OllamaProvider', () => {
  test('buildKwargs maps tools to Ollama function schema', () => {
    const provider = new OllamaProvider();
    const body = provider.buildKwargs({
      model: 'qwen2.5:3b',
      system: [{ text: 'base', cacheable: true }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 64,
      temperature: 0.2,
      tools: [{ name: 'Echo', description: 'echo input', input_schema: { type: 'object' } }],
    });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'base' });
    expect(body.tools?.[0]?.function.name).toBe('Echo');
    expect(body.options?.num_predict).toBe(64);
  });
});

describe('translateOllamaStream', () => {
  test('assembles content and complete tool calls', async () => {
    const chunks: OllamaChatChunk[] = [
      { message: { content: 'use ' } },
      {
        message: {
          tool_calls: [{ function: { name: 'Echo', arguments: { text: 'x' } } }],
        },
        done: true,
        done_reason: 'stop',
      },
    ];

    const yielded: StreamEvent[] = [];
    let returned: AssistantMessage | undefined;
    const gen = translateOllamaStream(iterate(chunks));
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
      'tool_use_delta',
      'message_stop',
      'assistant_message',
    ]);
    expect(returned?.content).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'tool_use', id: 'ollama_tool_0', name: 'Echo', input: { text: 'x' } },
    ]);
  });
});
