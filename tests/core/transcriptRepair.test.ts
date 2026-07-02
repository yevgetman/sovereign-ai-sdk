import { describe, expect, test } from 'bun:test';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type { Message } from '@yevgetman/sov-sdk/core/types';

describe('repairMissingToolResults', () => {
  test('inserts an error tool_result after an orphaned assistant tool_use', () => {
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
    expect(repaired.messages).toHaveLength(3);
    expect(repaired.messages[1]?.role).toBe('user');
    const block = repaired.messages[1]?.content[0];
    expect(block?.type).toBe('tool_result');
    expect(block?.type === 'tool_result' ? block.tool_use_id : '').toBe('toolu_1');
    expect(block?.type === 'tool_result' ? block.is_error : false).toBe(true);
    expect(repaired.messages[2]).toEqual(messages[1]);
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
