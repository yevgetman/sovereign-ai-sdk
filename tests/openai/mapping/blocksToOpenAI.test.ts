// Phase 18 T2 — pure-function tests for the internal ContentBlock[] →
// OpenAI assistant-message mapping. Text blocks concatenate into the
// `content` string; `tool_use` blocks become a `tool_calls` array; the
// shape matches OpenAI's spec (content is null when only tool_use is
// present so SDKs that strictly check for `content: null | string` accept
// the tool-only assistant message).

import { describe, expect, test } from 'bun:test';
import type { ContentBlock } from '@yevgetman/sov-sdk/core/types';
import { blocksToOpenAI } from '../../../src/openai/mapping/blocksToOpenAI.js';

describe('blocksToOpenAI', () => {
  test('text blocks concatenate into content string with no tool_calls', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world.' },
    ];
    const result = blocksToOpenAI(blocks);
    expect(result.content).toBe('Hello world.');
    expect(result.tool_calls).toBeUndefined();
  });

  test('single text block produces single-text content', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello world.' }];
    const result = blocksToOpenAI(blocks);
    expect(result.content).toBe('Hello world.');
    expect(result.tool_calls).toBeUndefined();
  });

  test('mixed text + tool_use → content string + tool_calls', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'I will call' },
      { type: 'tool_use', id: 'call_1', name: 'FileRead', input: { path: '/x' } },
    ];
    const result = blocksToOpenAI(blocks);
    expect(result.content).toBe('I will call');
    expect(result.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'FileRead', arguments: '{"path":"/x"}' },
      },
    ]);
  });

  test('all tool_use blocks → content is null, tool_calls populated', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'call_1', name: 'FileRead', input: { path: '/x' } },
      { type: 'tool_use', id: 'call_2', name: 'Bash', input: { command: 'ls' } },
    ];
    const result = blocksToOpenAI(blocks);
    expect(result.content).toBeNull();
    expect(result.tool_calls).toHaveLength(2);
    expect(result.tool_calls?.[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'FileRead', arguments: '{"path":"/x"}' },
    });
    expect(result.tool_calls?.[1]).toEqual({
      id: 'call_2',
      type: 'function',
      function: { name: 'Bash', arguments: '{"command":"ls"}' },
    });
  });

  test('empty content blocks → empty string content, no tool_calls', () => {
    const blocks: ContentBlock[] = [];
    const result = blocksToOpenAI(blocks);
    expect(result.content).toBe('');
    expect(result.tool_calls).toBeUndefined();
  });

  test('thinking blocks are skipped (internal-only)', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'reasoning step' },
      { type: 'text', text: 'final answer' },
    ];
    const result = blocksToOpenAI(blocks);
    expect(result.content).toBe('final answer');
    expect(result.tool_calls).toBeUndefined();
  });
});
