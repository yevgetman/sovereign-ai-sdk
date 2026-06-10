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
    // The assistant message maps text + tool_use as before. FIX 1's
    // transcript repair appends a synthetic tool_result for the orphaned
    // tool_use (no matching `tool` message in the request) so the sequence
    // stays Anthropic-valid — hence the trailing repaired user message.
    expect(result.messages).toHaveLength(2);
    const msg = result.messages[0];
    expect(msg?.role).toBe('assistant');
    expect(msg?.content).toEqual([
      { type: 'text', text: 'I will call' },
      { type: 'tool_use', id: 'call_1', name: 'FileRead', input: { path: '/x' } },
    ]);
    expect(result.messages[1]?.role).toBe('user');
    expect(result.messages[1]?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_1',
      is_error: true,
    });
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

  // FIX 1 — Anthropic requires ALL tool_results for one assistant turn to
  // live in the IMMEDIATELY-NEXT single user message. OpenAI clients answer
  // parallel tool_calls with separate `tool` messages; mapping each to its
  // own user message produces assistant[A,B] → user[result A] → user[result B],
  // which upstream Anthropic rejects (400). The mapper must merge consecutive
  // tool-result-derived user messages into one.
  test('merges two parallel tool_calls answered by two tool messages into one user message', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'FileRead', arguments: '{}' } },
            { id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'result A' },
        { role: 'tool', tool_call_id: 'call_b', content: 'result B' },
      ],
      stream: false,
    });
    // assistant message + exactly ONE merged user message carrying BOTH results.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe('assistant');
    const merged = result.messages[1];
    expect(merged?.role).toBe('user');
    expect(merged?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_a', content: 'result A' },
      { type: 'tool_result', tool_use_id: 'call_b', content: 'result B' },
    ]);
  });

  test('does not merge a tool-result user message with an adjacent text user message', () => {
    // A plain text user message must stay distinct — only consecutive
    // tool_result-derived user messages collapse. (A trailing text turn
    // after a tool result is the normal "next prompt".)
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'FileRead', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'result A' },
        { role: 'user', content: 'now what?' },
      ],
      stream: false,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_a', content: 'result A' },
    ]);
    expect(result.messages[2]?.content).toEqual([{ type: 'text', text: 'now what?' }]);
  });

  test('repairs an orphaned tool_call with no matching tool message (synthesizes a result)', () => {
    // A client replaying the harness's own streamed tool_calls WITHOUT
    // results leaves an orphan tool_use → Anthropic 400. The mapper runs
    // repairMissingToolResults() so every tool_use is followed by a result.
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'orphan_1', type: 'function', function: { name: 'Bash', arguments: '{}' } },
          ],
        },
      ],
      stream: false,
    });
    // assistant message + a synthesized user message carrying the result.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe('assistant');
    const repaired = result.messages[1];
    expect(repaired?.role).toBe('user');
    const block = repaired?.content[0];
    expect(block?.type).toBe('tool_result');
    expect(block).toMatchObject({ tool_use_id: 'orphan_1', is_error: true });
  });

  test('synthesizes the missing result when only one of two parallel tool_calls is answered', () => {
    // assistant[A,B] + tool(A) only → merge leaves user[result A]; repair
    // appends a synthetic result for B into that SAME user message so no
    // orphan tool_use remains.
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'FileRead', arguments: '{}' } },
            { id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'result A' },
      ],
      stream: false,
    });
    expect(result.messages).toHaveLength(2);
    const user = result.messages[1];
    expect(user?.role).toBe('user');
    const ids = (user?.content ?? []).map((b) =>
      b.type === 'tool_result' ? b.tool_use_id : undefined,
    );
    expect(ids).toEqual(['call_a', 'call_b']);
    // The real result is preserved; only the missing one is synthetic.
    expect(user?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_a',
      content: 'result A',
    });
    expect(user?.content[1]).toMatchObject({ tool_use_id: 'call_b', is_error: true });
  });
});
