import { describe, expect, test } from 'bun:test';
import { substituteAssistantText } from '@yevgetman/sov-sdk/core/conductOutput';
import type { AssistantMessage } from '@yevgetman/sov-sdk/core/types';

describe('substituteAssistantText', () => {
  test('replaces text blocks with one substituted block; preserves tool_use order', () => {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'leaky secret' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
        { type: 'text', text: 'more leak' },
      ],
    };
    const out = substituteAssistantText(message, '[withheld]');
    expect(out.content).toEqual([
      { type: 'text', text: '[withheld]' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
    ]);
    // Original untouched (immutability).
    expect(message.content).toHaveLength(3);
  });

  test('message with no text blocks gains one leading text block', () => {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
    };
    const out = substituteAssistantText(message, '[withheld]');
    expect(out.content[0]).toEqual({ type: 'text', text: '[withheld]' });
    expect(out.content[1]?.type).toBe('tool_use');
  });
});
