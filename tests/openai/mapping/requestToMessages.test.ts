// Phase 18 T2 — pure-function tests for the OpenAI ChatRequest → internal
// Message[] mapping. The mapping lifts `system` role messages into
// `extraSystemSegments` (the harness builds its own systemPrompt at runtime
// boot; per-request system text appends), maps `user`/`assistant`/`tool`
// roles into Anthropic-style ContentBlock[] internally, and treats `tool`
// role messages as user-role messages with `tool_result` content blocks.

import { describe, expect, test } from 'bun:test';
import { requestToMessages } from '../../../src/openai/mapping/requestToMessages.js';

describe('requestToMessages', () => {
  test('maps a simple user message', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg?.role).toBe('user');
    expect(msg?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.extraSystemSegments).toEqual([]);
  });

  test('lifts system messages into extraSystemSegments and drops them from messages', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
    });
    expect(result.extraSystemSegments).toEqual(['you are helpful']);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('user');
  });

  test('concatenates multiple system messages in declaration order', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        { role: 'system', content: 'system one' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'system two' },
      ],
      stream: false,
    });
    expect(result.extraSystemSegments).toEqual(['system one', 'system two']);
    expect(result.messages).toHaveLength(1);
  });

  test('maps assistant message with tool_calls into tool_use content blocks', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        {
          role: 'assistant',
          content: 'I will call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'FileRead', arguments: '{"path":"/x"}' },
            },
          ],
        },
      ],
      stream: false,
    });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg?.role).toBe('assistant');
    expect(msg?.content).toEqual([
      { type: 'text', text: 'I will call' },
      { type: 'tool_use', id: 'call_1', name: 'FileRead', input: { path: '/x' } },
    ]);
  });

  test('assistant message with null/empty content + tool_calls omits the text block', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'FileRead', arguments: '{}' },
            },
          ],
        },
      ],
      stream: false,
    });
    const msg = result.messages[0];
    expect(msg?.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'FileRead', input: {} }]);
  });

  test('maps tool role into user-role tool_result block', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'FileRead', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      ],
      stream: false,
    });
    expect(result.messages).toHaveLength(2);
    const toolMsg = result.messages[1];
    expect(toolMsg?.role).toBe('user');
    expect(toolMsg?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' },
    ]);
  });

  test('maps multi-turn conversation correctly', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
      stream: false,
    });
    expect(result.extraSystemSegments).toEqual(['sys']);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.role).toBe('user');
    expect(result.messages[1]?.role).toBe('assistant');
    expect(result.messages[1]?.content).toEqual([{ type: 'text', text: 'a1' }]);
    expect(result.messages[2]?.role).toBe('user');
  });

  test('throws on invalid JSON arguments in tool_calls', () => {
    expect(() =>
      requestToMessages({
        model: 'harness-default',
        messages: [
          {
            role: 'assistant',
            content: 'x',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'FileRead', arguments: '{not json' },
              },
            ],
          },
        ],
        stream: false,
      }),
    ).toThrow();
  });
});
