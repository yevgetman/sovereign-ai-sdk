// Turn-scoped tool restrictions for prompt commands. The command registry
// can say "this prompt may use Bash(git status)"; this module filters the
// visible tool pool and denies any attempted tool call outside that scope.

import {
  type ParsedPermissionRule,
  parsePermissionRule,
  ruleMatchesTool,
} from '../config/rules.js';
import type { CanUseTool } from '../permissions/types.js';
import type { Tool } from '../tool/types.js';

export type ToolScope = {
  rules: ParsedPermissionRule[];
  // biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8) — see createAgent AgentConfig.tools.
  tools: Tool<any, any>[];
  canUseTool: CanUseTool;
};

/** Filter a raw allow-list to entries `parsePermissionRule` accepts, dropping
 *  (and warning about) any that throw. Used on the `/skill` path before
 *  `buildToolScope` so a single genuinely-malformed entry (e.g. an imported
 *  Claude Code skill carrying `Bash(git log` with no closing paren) degrades
 *  to "that one rule is ignored" rather than throwing and failing the whole
 *  turn with a turn_error.
 *
 *  Dropping an allow-entry is FAIL-CLOSED — the tool it would have permitted
 *  simply stays out of scope (denied) — so this never widens capability. Kept
 *  separate from `buildToolScope` so the agent path (which should surface a
 *  malformed rule as a hard error) is unaffected. */
export function filterParseableRules(
  entries: readonly string[],
  warn?: (message: string) => void,
): string[] {
  const kept: string[] = [];
  for (const entry of entries) {
    try {
      parsePermissionRule(entry);
      kept.push(entry);
    } catch (err) {
      warn?.(
        `skill allowedTools: dropping unparseable rule ${JSON.stringify(entry)} (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
  return kept;
}

export function buildToolScope(opts: {
  allowedTools: readonly string[] | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8) — see createAgent AgentConfig.tools.
  tools: Tool<any, any>[];
  canUseTool: CanUseTool;
}): ToolScope {
  if (!opts.allowedTools || opts.allowedTools.length === 0) {
    return { rules: [], tools: opts.tools, canUseTool: opts.canUseTool };
  }
  const rules = opts.allowedTools.map(parsePermissionRule);
  const tools = opts.tools.filter((tool) => rules.some((rule) => ruleMatchesTool(tool, rule)));
  const canUseTool: CanUseTool = async (tool, input, ctx) => {
    const allowed = await matchesAnyScopeRule(tool, input, rules);
    if (!allowed) {
      return { behavior: 'deny', reason: 'tool is outside slash-command scope' };
    }
    return opts.canUseTool(tool, input, ctx);
  };
  return { rules, tools, canUseTool };
}

async function matchesAnyScopeRule(
  tool: Tool<unknown, unknown>,
  input: unknown,
  rules: ParsedPermissionRule[],
): Promise<boolean> {
  const toolRules = rules.filter((rule) => ruleMatchesTool(tool, rule));
  if (toolRules.length === 0) return false;
  if (toolRules.some((rule) => rule.content === null)) return true;
  if (!tool.preparePermissionMatcher) return false;
  const matcher = await tool.preparePermissionMatcher(input);
  return toolRules.some((rule) => rule.content !== null && matcher(rule.content));
}
