import { describe, expect, test } from 'bun:test';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { LEARNING_ONLY_TOOLS, assembleToolPool } from '../../src/tool/registry.js';

describe('LEARNING_ONLY_TOOLS pool isolation', () => {
  test('main agent pool excludes all 4 instinct tools', () => {
    const pool = assembleToolPool({ cwd: '/tmp', sessionId: 'x' } as ToolContext);
    const names = new Set(pool.map((t) => t.name));
    expect(names.has('instinct_list')).toBe(false);
    expect(names.has('instinct_view')).toBe(false);
    expect(names.has('instinct_propose')).toBe(false);
    expect(names.has('instinct_update_confidence')).toBe(false);
  });

  test('LEARNING_ONLY_TOOLS exports exactly 4 tools with the right names', () => {
    const names = new Set(LEARNING_ONLY_TOOLS.map((t) => t.name));
    expect(names.has('instinct_list')).toBe(true);
    expect(names.has('instinct_view')).toBe(true);
    expect(names.has('instinct_propose')).toBe(true);
    expect(names.has('instinct_update_confidence')).toBe(true);
    expect(LEARNING_ONLY_TOOLS.length).toBe(4);
  });
});
