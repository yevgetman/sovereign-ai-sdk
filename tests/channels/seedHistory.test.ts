// Unit tests for the bounded, pairing-safe channel history seeder (Fix 2a).
//
// `capSeededHistory` is the load-bearing truncation that keeps a long-running
// channel conversation from overflowing the model's context window. It must:
//   - return a SHORT history unchanged (no-op under the cap);
//   - cap a LONG history to the last N messages;
//   - never let the seed START with an orphan tool_result (a user message whose
//     leading block is a tool_result whose tool_use was truncated away), and
//   - repair any tool_use left WITHOUT a tool_result inside the retained window.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_SEEDED_MESSAGES, capSeededHistory } from '../../src/channels/seedHistory.js';
import type { Message } from '../../src/core/types.js';

function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function assistantWithToolUse(id: string): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id, name: 'Bash', input: { command: 'echo hi' } },
    ],
  };
}
function userWithToolResult(id: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'hi', is_error: false }],
  };
}

describe('capSeededHistory', () => {
  test('a history under the cap is returned unchanged', () => {
    const history = [userText('a'), assistantText('b'), userText('c')];
    const { messages, insertedToolResults } = capSeededHistory(
      history,
      DEFAULT_MAX_SEEDED_MESSAGES,
    );
    expect(messages).toEqual(history);
    expect(insertedToolResults).toBe(0);
  });

  test('a long history is capped to the last N messages', () => {
    const history: Message[] = [];
    for (let i = 0; i < 100; i++) {
      history.push(i % 2 === 0 ? userText(`u${i}`) : assistantText(`a${i}`));
    }
    const { messages } = capSeededHistory(history, 10);
    expect(messages.length).toBeLessThanOrEqual(10);
    // The retained window is the TAIL — the last message is preserved.
    expect(messages[messages.length - 1]).toEqual(history[history.length - 1]);
    // The oldest messages were dropped.
    expect(messages).not.toContainEqual(history[0]);
  });

  test('the seed never starts with an orphan tool_result', () => {
    // Build pairs so the raw cap boundary would land on a tool_result (the
    // user half of a pair) as the first message.
    const history: Message[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(assistantWithToolUse(`tu-${i}`));
      history.push(userWithToolResult(`tu-${i}`));
    }
    // Cap at an EVEN number so the naive tail would begin on a user tool_result.
    const { messages } = capSeededHistory(history, 4);
    expect(messages.length).toBeGreaterThan(0);
    const first = messages[0];
    const firstIsToolResult =
      first?.role === 'user' && first.content.some((b) => b.type === 'tool_result');
    expect(firstIsToolResult).toBe(false);
    // The first retained message is an assistant message (the tool_use head).
    expect(first?.role).toBe('assistant');
  });

  test('a tool_use whose tool_result was truncated off the end is repaired', () => {
    // History ends with an assistant tool_use and NO matching tool_result (e.g.
    // a prior turn crashed mid-tool-call). The repair must synthesize one so the
    // seed is provider-valid.
    const history: Message[] = [
      userText('hi'),
      assistantText('ok'),
      assistantWithToolUse('orphan-tu'),
    ];
    const { messages, insertedToolResults } = capSeededHistory(
      history,
      DEFAULT_MAX_SEEDED_MESSAGES,
    );
    expect(insertedToolResults).toBe(1);
    // The synthesized tool_result is the last message and references the tool_use.
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(
      last?.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'orphan-tu'),
    ).toBe(true);
  });

  test('maxMessages is clamped to at least 1', () => {
    const history = [userText('a'), assistantText('b'), userText('c')];
    const { messages } = capSeededHistory(history, 0);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    // The most recent message is always retained.
    expect(messages[messages.length - 1]).toEqual(history[history.length - 1]);
  });
});
