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
  tools: Tool<unknown, unknown>[];
  canUseTool: CanUseTool;
};

export function buildToolScope(opts: {
  allowedTools: readonly string[] | undefined;
  tools: Tool<unknown, unknown>[];
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
