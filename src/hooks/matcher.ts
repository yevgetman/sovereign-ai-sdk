// Decides whether a registered HookConfig fires for a given event payload.
// Tool events match by `tool_name` (literal or `*`); prompt/stop events fire
// for every registered hook (matcher ignored). Glob support (`mcp__*`) lands
// when MCP does in Phase 12.

import type { HookConfig, HookEvent } from './types.js';

export function matchesHook(config: HookConfig, event: HookEvent): boolean {
  if (event.hookEventName === 'PreToolUse' || event.hookEventName === 'PostToolUse') {
    if (config.matcher === undefined || config.matcher === '' || config.matcher === '*') {
      return true;
    }
    return config.matcher === event.tool_name;
  }
  // UserPromptSubmit, Stop — no per-event filter.
  return true;
}
