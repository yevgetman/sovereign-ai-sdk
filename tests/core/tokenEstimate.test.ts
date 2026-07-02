import { describe, expect, test } from 'bun:test';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateSystemPromptTokens,
  estimateTextTokens,
} from '@yevgetman/sov-sdk/core/tokenEstimate';
import type { Message } from '@yevgetman/sov-sdk/core/types';

describe('token estimator', () => {
  test('uses a cheap four-character text estimate', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
  });

  test('estimates messages and system segments with overhead', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }],
      },
    ];
    const first = messages[0];
    if (!first) throw new Error('missing fixture message');
    expect(estimateMessageTokens(first)).toBeGreaterThan(10);
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(estimateMessageTokens(first));
    expect(estimateSystemPromptTokens([{ text: 'system rules', cacheable: true }])).toBeGreaterThan(
      10,
    );
  });
});
