// Turn-loop tests. Phase 0: placeholder — just asserts query() is an async
// generator with the right signature. Phase 1: fixture-based replay tests
// against recorded stream events.

import { describe, expect, test } from 'bun:test';
import { query } from '../../src/core/query.js';

describe('query() — Phase 0 smoke', () => {
  test('returns an async generator', () => {
    const gen = query({
      // biome-ignore lint/suspicious/noExplicitAny: provider not used in Phase 0
      provider: {} as any,
      model: 'claude-opus-4-7',
      messages: [],
      systemPrompt: [],
      maxTokens: 1024,
    });
    expect(typeof gen[Symbol.asyncIterator]).toBe('function');
  });

  test('terminates with completed when no tool use', async () => {
    const gen = query({
      // biome-ignore lint/suspicious/noExplicitAny: provider not used in Phase 0
      provider: {} as any,
      model: 'claude-opus-4-7',
      messages: [],
      systemPrompt: [],
      maxTokens: 1024,
    });
    // Phase 0 returns immediately with { reason: 'completed' }.
    const result = await gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toEqual({ reason: 'completed' });
  });
});
