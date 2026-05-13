// Phase 16.1 M3.2 — every native tool in the assembled pool declares a
// renderHint per spec §7. Backstop test: when a new tool ships without one,
// this fails until the author picks a hint.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import {
  LEARNING_ONLY_TOOLS,
  REVIEW_ONLY_TOOLS,
  assembleToolPool,
} from '../../src/tool/registry.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';

describe('renderHint coverage', () => {
  test('every native tool in the assembled pool declares a renderHint', () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'coverage-test',
      harnessHome: tmpdir(),
    };
    const pool = assembleToolPool(ctx);
    const missing: string[] = [];
    for (const tool of pool) {
      if (tool.renderHint === undefined) {
        missing.push(tool.name);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every review-only tool declares a renderHint', () => {
    const missing = collectMissing(REVIEW_ONLY_TOOLS);
    expect(missing).toEqual([]);
  });

  test('every learning-only tool declares a renderHint', () => {
    const missing = collectMissing(LEARNING_ONLY_TOOLS);
    expect(missing).toEqual([]);
  });
});

function collectMissing(tools: Tool<unknown, unknown>[]): string[] {
  const missing: string[] = [];
  for (const tool of tools) {
    if (tool.renderHint === undefined) missing.push(tool.name);
  }
  return missing;
}
