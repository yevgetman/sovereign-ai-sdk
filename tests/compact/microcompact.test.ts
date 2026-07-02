import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MICROCOMPACT_CONFIG,
  type MicrocompactConfig,
  buildMicrocompactConfig,
  buildToolNameMap,
  microcompact,
  shouldMicrocompact,
} from '@yevgetman/sov-sdk/compact/microcompact';
import type { Message } from '@yevgetman/sov-sdk/core/types';

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

// F9 — microcompact must tolerate array-shaped tool_result content. A REAL
// Anthropic transcript (or a session rehydrated from a consumer's own store)
// may carry tool_result `content` as an ARRAY of content blocks (image /
// structured results), which is legal per the Anthropic wire shape even
// though the internal ContentBlock type declares `content: string`. TS types
// are erased at runtime, so such a shape flows through unchecked. Before the
// fix, collectCompactableRefs called `block.content.startsWith(...)` on it and
// threw `TypeError: block.content.startsWith is not a function`, aborting the
// turn. Non-string content is treated as non-compactable (passed through).
function arrayContentToolResult(toolUseId: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        // Legal Anthropic shape: an array of content blocks, injected at
        // runtime by a consumer replaying a transcript (TS type is erased).
        content: [{ type: 'text', text: 'structured tool result' }] as unknown as string,
      },
    ],
  };
}

describe('microcompact — array-shaped tool_result content (F9)', () => {
  test('does not crash on array content and passes it through untouched', () => {
    const messages: Message[] = [];
    // Prior-turn string tool_results (compactable).
    for (let i = 0; i < 2; i++) {
      const id = `pre-${i}`;
      messages.push(toolUse(id, 'Read'));
      messages.push(toolResult(id, `string content ${i} `.repeat(50)));
    }
    // An array-content tool_result in the middle (legal replayed shape).
    messages.push(toolUse('img', 'Read'));
    messages.push(arrayContentToolResult('img'));
    for (let i = 0; i < 2; i++) {
      const id = `post-${i}`;
      messages.push(toolUse(id, 'Read'));
      messages.push(toolResult(id, `string content post ${i} `.repeat(50)));
    }
    // Final text-bearing user message = current-turn boundary, so every
    // tool_result above is prior-turn and therefore eligible for inspection.
    messages.push({ role: 'user', content: [{ type: 'text', text: 'next prompt' }] });

    const toolNames = buildToolNameMap(messages);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 1 };

    // RED before fix: throws `TypeError: block.content.startsWith is not a function`.
    const { messages: compacted, result } = microcompact(messages, toolNames, config);

    // The array-content block is passed through UNTOUCHED (never compacted).
    const arrayBlock = compacted
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 'img');
    expect(arrayBlock?.type === 'tool_result' && Array.isArray(arrayBlock.content)).toBe(true);

    // The four string candidates still compact: keepRecent=1 -> 3 cleared.
    expect(result.cleared).toBe(3);
    const clearedStrings = compacted
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === 'tool_result' &&
          typeof b.content === 'string' &&
          b.content.startsWith('[Tool result cleared'),
      );
    expect(clearedStrings.length).toBe(3);
  });

  test('array-content tool_result is never selected as a clear candidate', () => {
    // keepRecent=0 would otherwise clear every compactable candidate. The
    // array-content block must still be excluded and pass through untouched.
    const messages: Message[] = [
      toolUse('img', 'Read'),
      arrayContentToolResult('img'),
      toolUse('s', 'Read'),
      toolResult('s', 'plain string output '.repeat(50)),
      { role: 'user', content: [{ type: 'text', text: 'boundary prompt' }] },
    ];
    const toolNames = buildToolNameMap(messages);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 0 };

    const { messages: compacted, result } = microcompact(messages, toolNames, config);

    // Only the single string result is cleared; the array block is untouched.
    expect(result.cleared).toBe(1);
    const arrayBlock = compacted
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 'img');
    expect(arrayBlock?.type === 'tool_result' && Array.isArray(arrayBlock.content)).toBe(true);
  });

  test('regression: plain string tool_result content still compacts', () => {
    const { messages, toolNames } = buildHistory(8);
    const config: MicrocompactConfig = { ...DEFAULT_MICROCOMPACT_CONFIG, keepRecent: 3 };
    const { messages: compacted, result } = microcompact(messages, toolNames, config);
    expect(result.cleared).toBe(5);
    const live = compacted.flatMap((m) =>
      m.content.filter(
        (b) =>
          b.type === 'tool_result' && !(b.content as string).startsWith('[Tool result cleared'),
      ),
    );
    expect(live.length).toBe(3);
  });
});

describe('buildMicrocompactConfig', () => {
  test('returns DEFAULT_MICROCOMPACT_CONFIG reference when settings undefined', () => {
    const cfg = buildMicrocompactConfig(undefined);
    expect(cfg).toBe(DEFAULT_MICROCOMPACT_CONFIG);
  });

  test('overrides enabled when specified', () => {
    const cfg = buildMicrocompactConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
    expect(cfg.keepRecent).toBe(DEFAULT_MICROCOMPACT_CONFIG.keepRecent);
    expect(cfg.triggerThresholdPct).toBe(DEFAULT_MICROCOMPACT_CONFIG.triggerThresholdPct);
    expect(cfg.compactableTools).toBe(DEFAULT_MICROCOMPACT_CONFIG.compactableTools);
  });

  test('overrides keepRecent when specified', () => {
    const cfg = buildMicrocompactConfig({ keepRecent: 10 });
    expect(cfg.keepRecent).toBe(10);
    expect(cfg.enabled).toBe(DEFAULT_MICROCOMPACT_CONFIG.enabled);
    expect(cfg.triggerThresholdPct).toBe(DEFAULT_MICROCOMPACT_CONFIG.triggerThresholdPct);
  });

  test('overrides triggerThresholdPct when specified', () => {
    const cfg = buildMicrocompactConfig({ triggerThresholdPct: 60 });
    expect(cfg.triggerThresholdPct).toBe(60);
    expect(cfg.enabled).toBe(DEFAULT_MICROCOMPACT_CONFIG.enabled);
    expect(cfg.keepRecent).toBe(DEFAULT_MICROCOMPACT_CONFIG.keepRecent);
  });

  test('overrides all specified fields simultaneously, preserves compactableTools', () => {
    const cfg = buildMicrocompactConfig({ enabled: false, keepRecent: 3, triggerThresholdPct: 20 });
    expect(cfg.enabled).toBe(false);
    expect(cfg.keepRecent).toBe(3);
    expect(cfg.triggerThresholdPct).toBe(20);
    expect(cfg.compactableTools).toBe(DEFAULT_MICROCOMPACT_CONFIG.compactableTools);
  });
});
