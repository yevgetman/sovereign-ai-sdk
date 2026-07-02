// The factory. Defaults FIRST, user overrides LAST. Every registered tool
// has every method after this runs; dispatch code never needs guards. The
// defaults are fail-closed — forgetting to mark a tool concurrency-safe
// means it runs serially (correct but slower), not in parallel with a
// conflicting tool (potential state corruption).
//
// Source of pattern: Claude Code src/Tool.ts:757-792 (buildTool +
// TOOL_DEFAULTS). This implementation is structurally identical.

import type { PermissionResult, Tool, ToolDef } from './types.js';

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  // Fail-closed: treat as potentially destructive until proven safe.
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  checkPermissions: async (): Promise<PermissionResult> => ({
    behavior: 'allow' as const,
  }),
  interruptBehavior: () => 'cancel' as const,
  shouldDefer: false,
};

/**
 * Build a Tool from a partial definition. Defaults are applied first, then
 * the definition overrides. Every returned Tool has every method populated.
 */
export function buildTool<I, O, P = void>(def: ToolDef<I, O, P>): Tool<I, O, P> {
  return {
    ...TOOL_DEFAULTS,
    ...def,
  } as Tool<I, O, P>;
}
