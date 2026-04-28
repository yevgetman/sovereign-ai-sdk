import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MICROCOMPACT_CONFIG,
  type MicrocompactConfig,
  buildToolNameMap,
  microcompact,
  shouldMicrocompact,
} from '../../src/compact/microcompact.js';
import type { Message } from '../../src/core/types.js';

function toolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  };
}

function toolResult(toolUseId: string, content: string, isError = false): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  };
}

function buildHistory(count: number): { messages: Message[]; toolNames: Map<string, string> } {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    const id = `tool-${i}`;
    messages.push(toolUse(id, 'Read'));
    messages.push(toolResult(id, `file content ${i} `.repeat(100)));
  }
  return { messages, toolNames: buildToolNameMap(messages) };
}

describe('buildToolNameMap', () => {
  test('maps tool_use ids to names', () => {
    const messages: Message[] = [
      toolUse('a', 'Bash'),
      toolResult('a', 'output'),
      toolUse('b', 'Read'),
      toolResult('b', 'content'),
    ];
    const map = buildToolNameMap(messages);
    expect(map.get('a')).toBe('Bash');
    expect(map.get('b')).toBe('Read');
    expect(map.size).toBe(2);
  });
});

describe('shouldMicrocompact', () => {
  test('returns false when disabled', () => {
    const { messages, toolNames } = buildHistory(10);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, enabled: false };
    expect(shouldMicrocompact(messages, config, toolNames)).toBe(false);
  });

  test('returns false when tool results are below threshold', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(10000) }] },
      toolUse('a', 'Read'),
      toolResult('a', 'short'),
    ];
    const toolNames = buildToolNameMap(messages);
    expect(shouldMicrocompact(messages, DEFAULT_MICROCOMPACT_CONFIG, toolNames)).toBe(false);
  });

  test('returns true when tool results dominate context', () => {
    const { messages, toolNames } = buildHistory(20);
    expect(shouldMicrocompact(messages, DEFAULT_MICROCOMPACT_CONFIG, toolNames)).toBe(true);
  });

  test('ignores error results', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      toolUse('a', 'Bash'),
      toolResult('a', 'x'.repeat(10000), true),
    ];
    const toolNames = buildToolNameMap(messages);
    expect(shouldMicrocompact(messages, DEFAULT_MICROCOMPACT_CONFIG, toolNames)).toBe(false);
  });

  test('ignores non-compactable tools', () => {
    const messages: Message[] = [toolUse('a', 'SkillTool'), toolResult('a', 'x'.repeat(10000))];
    const toolNames = buildToolNameMap(messages);
    expect(shouldMicrocompact(messages, DEFAULT_MICROCOMPACT_CONFIG, toolNames)).toBe(false);
  });
});

describe('microcompact', () => {
  test('does nothing when fewer results than keepRecent', () => {
    const { messages, toolNames } = buildHistory(3);
    const { result } = microcompact(messages, toolNames, DEFAULT_MICROCOMPACT_CONFIG);
    expect(result.cleared).toBe(0);
    expect(result.estimatedTokensSaved).toBe(0);
  });

  test('clears oldest results, keeps recent', () => {
    const { messages, toolNames } = buildHistory(8);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 3 };
    const { messages: compacted, result } = microcompact(messages, toolNames, config);
    expect(result.cleared).toBe(5);
    expect(result.keptRecent).toBe(3);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);

    // Verify the last 3 tool results are preserved
    const toolResults = compacted.flatMap((m) =>
      m.content.filter(
        (b) => b.type === 'tool_result' && !b.content.startsWith('[Tool result cleared'),
      ),
    );
    expect(toolResults.length).toBe(3);
  });

  test('preserves error results', () => {
    const messages: Message[] = [
      toolUse('a', 'Bash'),
      toolResult('a', 'x'.repeat(1000), true),
      toolUse('b', 'Read'),
      toolResult('b', 'y'.repeat(1000)),
    ];
    const toolNames = buildToolNameMap(messages);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 0 };
    const { messages: compacted, result } = microcompact(messages, toolNames, config);
    expect(result.cleared).toBe(1); // only the non-error Read result

    const errorResult = compacted
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.is_error);
    expect(errorResult?.type === 'tool_result' && errorResult.content).toContain('x'.repeat(100));
  });

  test('does not re-clear already cleared results', () => {
    const { messages, toolNames } = buildHistory(8);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 3 };

    const { messages: pass1 } = microcompact(messages, toolNames, config);
    const { result: pass2Result } = microcompact(pass1, toolNames, config);
    expect(pass2Result.cleared).toBe(0);
  });

  test('placeholder includes tool name', () => {
    const messages: Message[] = [
      toolUse('a', 'Grep'),
      toolResult('a', 'grep output '.repeat(100)),
      toolUse('b', 'Read'),
      toolResult('b', 'recent content'),
    ];
    const toolNames = buildToolNameMap(messages);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 1 };
    const { messages: compacted } = microcompact(messages, toolNames, config);

    const cleared = compacted
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.content.startsWith('[Tool result cleared'));
    expect(cleared?.type === 'tool_result' && cleared.content).toContain('Grep');
  });

  test('preserves message structure', () => {
    const { messages, toolNames } = buildHistory(8);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 3 };
    const { messages: compacted } = microcompact(messages, toolNames, config);
    expect(compacted.length).toBe(messages.length);
    for (let i = 0; i < compacted.length; i++) {
      expect(compacted[i]?.role).toBe(messages[i]?.role);
      expect(compacted[i]?.content.length).toBe(messages[i]?.content.length);
    }
  });
});
