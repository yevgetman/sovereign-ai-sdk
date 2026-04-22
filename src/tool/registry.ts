// Tool registry — assembles the per-turn tool pool. Filters by permission
// context, dedupes by name, sorts by name (cache stability). Phase 0: stub.
// Phase 2 (alongside first tool): returns [ReadBundleTool]. Phase 5+: MCP
// tools merged in.
//
// Source of pattern: Claude Code src/tools.ts (assembleToolPool).

import type { Tool } from './types.js';

export function assembleToolPool(): Tool<unknown, unknown>[] {
  // Phase 0: empty. Phase 2 adds ReadBundleTool and sorts.
  return [];
}
