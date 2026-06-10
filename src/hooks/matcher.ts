// Decides whether a registered HookConfig fires for a given event payload.
// Tool events match by `tool_name`; prompt/stop events fire for every
// registered hook (matcher ignored).
//
// The orchestrator stamps the CANONICAL tool name on the event (FileEdit /
// FileWrite / FileRead / Bash …), but operators naturally write matchers using
// the familiar aliases (Edit / Write / Read) and pipe-alternation
// ("Edit|Write") — exactly the form documented in usage.md. A matcher
// alternative therefore matches when it equals the canonical name, the wildcard
// `*`, OR an alias that resolves to (or from) the canonical name.

import type { HookConfig, HookEvent } from './types.js';

/** Alias → canonical tool name. Mirrors the `aliases:` declarations on the
 *  harness tools in src/tools/ (FileReadTool `aliases:['Read']`, etc.) — kept
 *  in sync with `CLAUDE_TO_NATIVE_TOOL_NAME` in runtime/subprocessExecutor.ts.
 *  Tools without an alias (Bash/Grep/Glob/MCP/…) match by their name directly. */
const ALIAS_TO_CANONICAL: Readonly<Record<string, string>> = {
  Read: 'FileRead',
  Write: 'FileWrite',
  Edit: 'FileEdit',
};

export function matchesHook(config: HookConfig, event: HookEvent): boolean {
  if (event.hookEventName === 'PreToolUse' || event.hookEventName === 'PostToolUse') {
    if (config.matcher === undefined || config.matcher === '' || config.matcher === '*') {
      return true;
    }
    return matchesToolName(config.matcher, event.tool_name);
  }
  // UserPromptSubmit, Stop — no per-event filter.
  return true;
}

/** True when any pipe-separated alternative in `matcher` matches the canonical
 *  `toolName`, by wildcard, exact name, or alias (in either direction). */
function matchesToolName(matcher: string, toolName: string): boolean {
  for (const raw of matcher.split('|')) {
    const alt = raw.trim();
    if (alt.length === 0) continue;
    if (alt === '*') return true;
    if (alt === toolName) return true;
    // Operator wrote an alias ("Edit") → resolve it to the canonical name.
    if (ALIAS_TO_CANONICAL[alt] === toolName) return true;
    // Defensive symmetry: operator wrote the canonical name while the event
    // somehow carries the alias — resolve the event's name and compare.
    if (ALIAS_TO_CANONICAL[toolName] === alt) return true;
  }
  return false;
}
