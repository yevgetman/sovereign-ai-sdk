import { describe, expect, test } from 'bun:test';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type { Message } from '@yevgetman/sov-sdk/core/types';

describe('repairMissingToolResults', () => {
  test('merges an error tool_result into a following plain-text user turn (no double user)', () => {
    // An orphaned tool_use followed by a PLAIN-TEXT user turn (no tool_results)
    // — the crash-then-new-message shape on channel/openai paths. The synthetic
    // result must MERGE into that user turn (results first, text after), NOT be
    // emitted as its own message: two consecutive `user` messages are a provider
    // 400, the exact failure repair exists to prevent.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
      },
      { role: 'user', content: [{ type: 'text', text: 'next request' }] },
    ];

    const repaired = repairMissingToolResults(messages);

    expect(repaired.insertedToolResults).toBe(1);
    expect(repaired.repairedAssistantMessages).toBe(1);
    // Exactly two messages — assistant, then a single merged user turn. No
    // consecutive same-role messages.
    expect(repaired.messages).toHaveLength(2);
    expect(repaired.messages[0]?.role).toBe('assistant');
    expect(repaired.messages[1]?.role).toBe('user');
    const mergedContent = repaired.messages[1]?.content ?? [];
    // tool_result leads, original text follows.
    const first = mergedContent[0];
    expect(first?.type).toBe('tool_result');
    expect(first?.type === 'tool_result' ? first.tool_use_id : '').toBe('toolu_1');
    expect(first?.type === 'tool_result' ? first.is_error : false).toBe(true);
    const second = mergedContent[1];
    expect(second?.type).toBe('text');
    expect(second?.type === 'text' ? second.text : '').toBe('next request');
    // Never two adjacent user messages.
    for (let i = 1; i < repaired.messages.length; i++) {
      expect(
        repaired.messages[i]?.role === 'user' && repaired.messages[i - 1]?.role === 'user',
      ).toBe(false);
    }
  });

  test('stands the synthetic result alone when no user message follows', () => {
    // Transcript ends on the orphaned tool_use — the synthetic result becomes
    // the answering user turn on its own.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
      },
    ];

    const repaired = repairMissingToolResults(messages);

    expect(repaired.insertedToolResults).toBe(1);
    expect(repaired.messages).toHaveLength(2);
    expect(repaired.messages[1]?.role).toBe('user');
    const block = repaired.messages[1]?.content[0];
    expect(block?.type).toBe('tool_result');
    expect(block?.type === 'tool_result' ? block.tool_use_id : '').toBe('toolu_1');
  });

  test('merges missing synthetic results into a partial next tool_result message', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'FileRead', input: { path: 'a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'FileRead', input: { path: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a contents' }],
      },
    ];

    const repaired = repairMissingToolResults(messages);

    expect(repaired.messages).toHaveLength(2);
    const resultIds = repaired.messages[1]?.content
      .filter((block) => block.type === 'tool_result')
      .map((block) => (block.type === 'tool_result' ? block.tool_use_id : ''));
    expect(resultIds).toEqual(['toolu_1', 'toolu_2']);
  });

  test('leaves already valid tool_use/tool_result pairs unchanged', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Glob', input: { pattern: '*' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'index.ts' }],
      },
    ];

    const repaired = repairMissingToolResults(messages);

    expect(repaired.insertedToolResults).toBe(0);
    expect(repaired.messages).toEqual(messages);
  });
});
