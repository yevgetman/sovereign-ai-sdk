// Regression test for #36 — the hydrate/resume path must coalesce consecutive
// same-role messages so a session corrupted by the pre-H7 bug (a standalone
// trailing guidance user message → two consecutive user messages) does not
// 400 on Anthropic ("roles must alternate") when resumed.

import { describe, expect, test } from 'bun:test';
import type { Message } from '@yevgetman/sov-sdk/core/types';
import { mergeConsecutiveSameRoleMessages } from '../../src/server/routes/turns.js';

describe('mergeConsecutiveSameRoleMessages (#36)', () => {
  test('merges two consecutive user messages into one (legacy-corrupted resume)', () => {
    const corrupted: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'original prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial reply' }] },
      // The pre-H7 standalone trailing guidance user message...
      { role: 'user', content: [{ type: 'text', text: 'guidance' }] },
      // ...followed by the freshly-persisted new user prompt on resume.
      { role: 'user', content: [{ type: 'text', text: 'new prompt' }] },
    ];

    const merged = mergeConsecutiveSameRoleMessages(corrupted);

    expect(merged).toHaveLength(3);
    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // The two trailing user messages fold into one, blocks preserved in order.
    expect(merged[2]?.content).toEqual([
      { type: 'text', text: 'guidance' },
      { type: 'text', text: 'new prompt' },
    ]);
  });

  test('coalesces a run of three or more consecutive same-role messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ];

    const merged = mergeConsecutiveSameRoleMessages(messages);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.content.map((b) => (b.type === 'text' ? b.text : ''))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('is a no-op for an already-alternating timeline', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ];

    const merged = mergeConsecutiveSameRoleMessages(messages);

    expect(merged).toEqual(messages);
  });

  test('merges consecutive PLAIN assistant messages too', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'part one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'follow-up' }] },
    ];

    const merged = mergeConsecutiveSameRoleMessages(messages);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.role).toBe('assistant');
    expect(merged[0]?.content).toHaveLength(2);
  });

  test('does NOT merge tool-bearing same-role messages (preserves tool pairing)', () => {
    // A legitimate trailing tool_result user message must NOT be folded into a
    // following user prompt — that would glue a stale tool_result onto the new
    // question and break the loop's tool_use/tool_result pairing (regression
    // guard for the microcompaction turn-loop tests).
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'out' }] },
      { role: 'user', content: [{ type: 'text', text: 'new prompt' }] },
    ];

    const merged = mergeConsecutiveSameRoleMessages(messages);

    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.role)).toEqual(['user', 'user']);
    // An assistant tool_use is likewise never coalesced into an adjacent assistant.
    const withToolUse: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: 'follow-up' }] },
    ];
    expect(mergeConsecutiveSameRoleMessages(withToolUse)).toHaveLength(2);
  });

  test('does not mutate the input array or its messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    mergeConsecutiveSameRoleMessages(messages);

    expect(messages).toEqual(snapshot);
    expect(messages).toHaveLength(2);
  });

  test('returns an empty array unchanged', () => {
    expect(mergeConsecutiveSameRoleMessages([])).toEqual([]);
  });
});
