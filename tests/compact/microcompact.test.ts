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

  // Backlog Item 22 — soak case G4: an autonomous burst inside a SINGLE
  // user prompt was triggering microcompact to clear mid-burst tool results
  // before the agent's next assistant message could reference them. The
  // current-turn boundary protection ensures tool_results produced after
  // the latest text-bearing user message are never evicted.
  test('does not evict tool_results from the current user turn', () => {
    // Build: [user "old prompt"] then 30 (tool_use, tool_result) pairs ALL
    // belonging to that single user turn. With keepRecent=3 and no current-
    // turn protection, the old behaviour would clear 27 of those 30 results
    // — exactly the failure mode case G4 surfaced.
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do something useful in this repo' }] },
    ];
    for (let i = 0; i < 30; i++) {
      const id = `tool-${i}`;
      messages.push(toolUse(id, 'Bash'));
      messages.push(toolResult(id, `bash output ${i} `.repeat(80)));
    }
    const toolNames = buildToolNameMap(messages);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 3 };

    const { messages: compacted, result } = microcompact(messages, toolNames, config);

    // Nothing should be cleared — the entire 30-result burst is in the
    // current turn (after the latest user-text message).
    expect(result.cleared).toBe(0);
    expect(result.estimatedTokensSaved).toBe(0);

    const liveResults = compacted.flatMap((m) =>
      m.content.filter(
        (b) => b.type === 'tool_result' && !b.content.startsWith('[Tool result cleared'),
      ),
    );
    expect(liveResults.length).toBe(30);
  });

  test('clears prior-turn tool_results but preserves current-turn ones', () => {
    // Two user prompts: 5 tool calls in turn A, then a new user prompt,
    // then 3 tool calls in turn B. With keepRecent=2, prior-turn results
    // should be evicted down to (keepRecent) but current-turn results
    // stay untouched regardless of count.
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    ];
    for (let i = 0; i < 5; i++) {
      const id = `prior-${i}`;
      messages.push(toolUse(id, 'Read'));
      messages.push(toolResult(id, `prior content ${i} `.repeat(60)));
    }
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'done with first prompt' }],
    });
    messages.push({ role: 'user', content: [{ type: 'text', text: 'second prompt' }] });
    for (let i = 0; i < 3; i++) {
      const id = `current-${i}`;
      messages.push(toolUse(id, 'Read'));
      messages.push(toolResult(id, `current content ${i} `.repeat(60)));
    }
    const toolNames = buildToolNameMap(messages);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 2 };

    const { messages: compacted, result } = microcompact(messages, toolNames, config);

    // Eligible candidates = 5 prior-turn results. keepRecent=2 of those.
    // So 3 prior-turn results should be cleared. The 3 current-turn
    // results are NOT in the candidate pool — they all stay live.
    expect(result.cleared).toBe(3);

    // Verify all 3 current-turn results are still live.
    const currentTurnResults = compacted
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === 'tool_result' &&
          typeof b.tool_use_id === 'string' &&
          b.tool_use_id.startsWith('current-') &&
          !b.content.startsWith('[Tool result cleared'),
      );
    expect(currentTurnResults.length).toBe(3);

    // And exactly 3 prior-turn results were cleared (out of 5).
    const priorClearedCount = compacted
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === 'tool_result' &&
          typeof b.tool_use_id === 'string' &&
          b.tool_use_id.startsWith('prior-') &&
          b.content.startsWith('[Tool result cleared'),
      ).length;
    expect(priorClearedCount).toBe(3);
  });

  test('treats standalone guidance message as a turn boundary', () => {
    // A standalone loop-detector guidance message is text-only and
    // user-role. We treat it as a boundary — anything after it is part of
    // the post-guidance burst and should not be evicted. (This is a
    // deliberately conservative call: false-negative eviction on guidance
    // borders is harmless; false-positive eviction on a real burst is the
    // bug case G4 surfaced.)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    ];
    for (let i = 0; i < 4; i++) {
      const id = `prior-${i}`;
      messages.push(toolUse(id, 'Read'));
      messages.push(toolResult(id, `pre-guidance ${i} `.repeat(60)));
    }
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: 'guidance: stop, change approach' }],
    });
    for (let i = 0; i < 6; i++) {
      const id = `post-${i}`;
      messages.push(toolUse(id, 'Read'));
      messages.push(toolResult(id, `post-guidance ${i} `.repeat(60)));
    }
    const toolNames = buildToolNameMap(messages);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 2 };

    const { result } = microcompact(messages, toolNames, config);

    // 4 prior-turn results are eligible; keepRecent=2; so 2 cleared.
    // 6 post-guidance results are protected by the boundary.
    expect(result.cleared).toBe(2);
  });
});
