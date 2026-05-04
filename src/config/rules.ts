// Rule parsing + generic wildcard helpers for Phase 7 permissions. The
// rule engine intentionally knows only the tool selector and the raw
// pattern; matching semantics stay delegated to each tool's matcher.

import type { Tool } from '../tool/types.js';

export type PermissionRuleBehavior = 'allow' | 'deny' | 'ask';

export type ParsedPermissionRule = {
  tool: string;
  content: string | null;
};

export type PermissionRule = ParsedPermissionRule & {
  behavior: PermissionRuleBehavior;
  raw: string;
};

export type PermissionRuleLayer = {
  source: string;
  rules: PermissionRule[];
};

const TOOL_SELECTOR_RE = /^[A-Za-z0-9_.:-]+$/;

export function parsePermissionRule(raw: string): ParsedPermissionRule {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('permission rule cannot be empty');
  }

  const open = trimmed.indexOf('(');
  if (open === -1) {
    assertToolSelector(trimmed, raw);
    return { tool: trimmed, content: null };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(`invalid permission rule ${JSON.stringify(raw)}: missing closing ')'`);
  }
  const tool = trimmed.slice(0, open).trim();
  assertToolSelector(tool, raw);
  const content = trimmed.slice(open + 1, -1).trim();
  return { tool, content: content.length > 0 ? content : null };
}

export function parsePermissionRules(
  behavior: PermissionRuleBehavior,
  rawRules: readonly string[],
): PermissionRule[] {
  return rawRules.map((raw) => ({ ...parsePermissionRule(raw), behavior, raw }));
}

export function ruleMatchesTool(tool: Tool<unknown, unknown>, rule: ParsedPermissionRule): boolean {
  if (rule.tool === tool.name) return true;
  if ((tool.aliases ?? []).includes(rule.tool)) return true;
  // Server-scoped MCP rule: `mcp__<server>` matches every tool from that server,
  // so `deny: ["mcp__github"]` blocks the whole server in one line. Tool-level
  // rules use the full `mcp__<server>__<tool>` name and hit the exact match above.
  if (tool.isMcp && tool.mcpInfo && rule.tool === `mcp__${tool.mcpInfo.serverName}`) return true;
  return false;
}

function assertToolSelector(tool: string, raw: string): void {
  if (!TOOL_SELECTOR_RE.test(tool)) {
    throw new Error(`invalid permission rule ${JSON.stringify(raw)}: invalid tool selector`);
  }
}

export type WildcardFlavor = 'file' | 'shell';

export function wildcardMatches(
  pattern: string,
  value: string,
  opts: { flavor?: WildcardFlavor; caseSensitive?: boolean } = {},
): boolean {
  const flavor = opts.flavor ?? 'file';
  const source = wildcardToRegExpSource(pattern, flavor);
  const flags = opts.caseSensitive === false ? 'i' : '';
  return new RegExp(`^${source}$`, flags).test(value);
}

function wildcardToRegExpSource(pattern: string, flavor: WildcardFlavor): string {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += flavor === 'shell' ? '\\S*' : '.*';
      }
    } else if (ch === '?') {
      source += flavor === 'shell' ? '\\S' : '.';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return source;
}

function escapeRegExp(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}
