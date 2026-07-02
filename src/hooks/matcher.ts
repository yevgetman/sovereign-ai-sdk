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

// Alias → canonical resolution comes from the canonical tool descriptors
// (src/tool/descriptors.ts) — the single source of truth mirroring the
// `aliases:` declarations on the harness tools in src/tools/ (FileReadTool
// `aliases:['Read']`, etc.). Tools without an alias (Bash/Grep/Glob/MCP/…)
// match by their name directly.
import { aliasToNativeName } from '../tool/descriptors.js';
import type { HookConfig, HookEvent } from './types.js';

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
    if (aliasToNativeName(alt) === toolName) return true;
    // Defensive symmetry: operator wrote the canonical name while the event
    // somehow carries the alias — resolve the event's name and compare.
    if (aliasToNativeName(toolName) === alt) return true;
  }
  return false;
}
