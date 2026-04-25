// OpenAI-compatible transport tests. No live API calls — these exercise
// message/tool conversion and stream-chunk normalization.

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, StreamEvent } from '../../src/core/types.js';
import {
  type OpenAIChatChunk,
  OpenAIProvider,
  messagesToOpenAI,
  translateOpenAIStream,
} from '../../src/providers/openai.js';

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
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
    const yielded: StreamEvent[] = [];
    let returned: AssistantMessage | undefined;
    const gen = translateOpenAIStream(iterate(chunks));
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
      'tool_use_delta',
      'message_stop',
      'assistant_message',
    ]);
    expect(returned?.content).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'x' } },
    ]);
  });
});
