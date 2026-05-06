// Phase 13.3 — assert that memory_propose / skill_propose are excluded from
// the main agent's pool and present in REVIEW_ONLY_TOOLS.

import { describe, expect, test } from 'bun:test';
import { REVIEW_ONLY_TOOLS, assembleToolPool } from '../../src/tool/registry.js';
import type { ToolContext } from '../../src/tool/types.js';

describe('review-only tools are not in the main agent pool', () => {
  test('assembleToolPool excludes memory_propose and skill_propose', () => {
    const ctx: ToolContext = { cwd: '/tmp', sessionId: 'x' };
    const pool = assembleToolPool(ctx);
    const names = new Set(pool.map((t) => t.name));
    expect(names.has('memory_propose')).toBe(false);
    expect(names.has('skill_propose')).toBe(false);
  });

  test('REVIEW_ONLY_TOOLS exports both propose tools', () => {
    const names = new Set(REVIEW_ONLY_TOOLS.map((t) => t.name));
    expect(names.has('memory_propose')).toBe(true);
    expect(names.has('skill_propose')).toBe(true);
    expect(REVIEW_ONLY_TOOLS.length).toBe(2);
  });
});
