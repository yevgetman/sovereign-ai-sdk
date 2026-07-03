import { describe, expect, test } from 'bun:test';
import {
  estimateBlockTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateSystemPromptTokens,
  estimateTextTokens,
} from '@yevgetman/sov-sdk/core/tokenEstimate';
import type { ContentBlock, Message } from '@yevgetman/sov-sdk/core/types';

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

// F9 sibling (D15) — estimateBlockTokens runs on the microcompaction gate
// (shouldMicrocompact → estimateBlockTokens) BEFORE the compact-path guards, so
// it must tolerate a non-string tool_result `content`. The internal type says
// `string`, but a consumer that rehydrates a session or replays a real Anthropic
// transcript can carry a MISSING body (undefined) or an ARRAY of content blocks
// (image / structured results). A non-string must yield a rough estimate, never
// a `.length` TypeError that aborts the turn.
describe('estimateBlockTokens — non-string tool_result content', () => {
  test('undefined content does not throw and returns a bounded estimate', () => {
    const block = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: undefined,
    } as unknown as ContentBlock;
    // RED before fix: `estimateTextTokens(undefined)` throws
    // "undefined is not an object (evaluating 'text.length')".
    let tokens = -1;
    expect(() => {
      tokens = estimateBlockTokens(block);
    }).not.toThrow();
    expect(Number.isFinite(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
  });

  test('array content does not throw and reflects the payload size', () => {
    const arrayBlock = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [
        { type: 'text', text: 'structured tool result payload, reasonably long content here' },
      ],
    } as unknown as ContentBlock;
    const undefinedBlock = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: undefined,
    } as unknown as ContentBlock;

    let arrayTokens = -1;
    expect(() => {
      arrayTokens = estimateBlockTokens(arrayBlock);
    }).not.toThrow();
    // A sane estimate reflects the serialized payload, so the array (with real
    // text) estimates strictly higher than the empty/undefined case — not the
    // bogus `array.length === 1` figure the pre-fix `.length` path produced.
    expect(arrayTokens).toBeGreaterThan(estimateBlockTokens(undefinedBlock));
  });

  test('plain string tool_result content is unchanged', () => {
    const stringBlock: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'abcd',
    };
    // Overhead (8) + tool_use_id estimate (>=1) + content estimate (1) — a
    // normal string path is unaffected by the non-string coercion.
    expect(estimateBlockTokens(stringBlock)).toBeGreaterThan(0);
  });
});
