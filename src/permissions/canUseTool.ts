// canUseTool — the orchestrator-level permission decider. Phase 7 adds
// layered rules around each tool's own self-check:
//   1. session/project-local/user rules, local before project before user
//   2. tool self-checks
//   3. mode fallthrough (default/ask/bypass)
// A 'deny' result becomes an is_error tool_result without invoking call().

import { type PermissionRule, type PermissionRuleLayer, ruleMatchesTool } from '../config/rules.js';
import { previewToolInput } from './prompt.js';
import type { AskUser, CanUseTool, PermissionMode } from './types.js';

export type BuildCanUseToolOpts = {
  mode: PermissionMode;
  ask: AskUser;
  /** Session-scoped allow rules. Mutated when the user answers 'always'. */
  alwaysAllow: Set<string>;
  /** Loaded in strict precedence order: local, project, user. */
  ruleLayers?: PermissionRuleLayer[];
  /** Optional persistence hook for `always` answers. */
  recordAlwaysAllow?: (rule: string) => Promise<void> | void;
};

export function buildCanUseTool(opts: BuildCanUseToolOpts): CanUseTool {
  return async (tool, input, ctx) => {
    const sessionRules = Array.from(
      opts.alwaysAllow,
      (raw): PermissionRule => ({
        behavior: 'allow',
        raw,
        ...parseAlreadyValidatedSessionRule(raw),
      }),
    );
    const ruleResult = await evaluateRuleLayers(tool, input, [
      { source: 'session', rules: sessionRules },
      ...(opts.ruleLayers ?? []),
    ]);
    if (ruleResult?.behavior === 'allow') return { behavior: 'allow' };
    if (ruleResult?.behavior === 'deny') {
      return {
        behavior: 'deny',
        ...(ruleResult.reason !== undefined ? { reason: ruleResult.reason } : {}),
      };
    }
    if (opts.mode === 'bypass' && ruleResult?.behavior !== 'ask') return { behavior: 'allow' };

    const selfCheck = await tool.checkPermissions(input, ctx);
    if (selfCheck.behavior === 'allow' && ruleResult?.behavior !== 'ask') {
      return { behavior: 'allow', ...passThroughFields(selfCheck) };
    }
    if (selfCheck.behavior === 'deny') {
      return { behavior: 'deny', ...passThroughFields(selfCheck) };
    }

    // 'ask' — surface to the human.
    const answer = await opts.ask({
      toolName: tool.name,
      preview: previewToolInput(input),
      ...(selfCheck.reason !== undefined ? { reason: selfCheck.reason } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (answer === 'always') {
      const rule = permissionRuleForInput(tool.name, input);
      opts.alwaysAllow.add(rule);
      await opts.recordAlwaysAllow?.(rule);
      return { behavior: 'allow' };
    }
    if (answer === 'allow') return { behavior: 'allow' };
    return { behavior: 'deny', reason: 'user denied' };
  };
}

async function evaluateRuleLayers(
  tool: Parameters<CanUseTool>[0],
  input: unknown,
  layers: PermissionRuleLayer[],
): Promise<{ behavior: 'allow' | 'deny' | 'ask'; reason?: string } | undefined> {
  for (const layer of layers) {
    const toolRules = layer.rules.filter((rule) => ruleMatchesTool(tool, rule));

    // Shell AST: if this tool maps its input to a virtual tool name (e.g.
    // Bash("cat foo") → "Read"), also check rules for that virtual tool.
    const virtualName = resolveVirtualToolName(tool, input);
    const virtualRules = virtualName ? layer.rules.filter((rule) => rule.tool === virtualName) : [];
    const allRules = [...toolRules, ...virtualRules];
    if (allRules.length === 0) continue;

    const matcher = await prepareMatcher(tool, input);
    const blanketDeny = allRules.find((rule) => rule.behavior === 'deny' && rule.content === null);
    if (blanketDeny) return denyFromRule(blanketDeny, layer.source);

    const patternDeny = allRules.find(
      (rule) => rule.behavior === 'deny' && rule.content !== null && matcher(rule.content),
    );
    if (patternDeny) return denyFromRule(patternDeny, layer.source);

    const patternAllow = allRules.find(
      (rule) => rule.behavior === 'allow' && rule.content !== null && matcher(rule.content),
    );
    if (patternAllow) return { behavior: 'allow' };

    const blanketAllow = allRules.find(
      (rule) => rule.behavior === 'allow' && rule.content === null,
    );
    if (blanketAllow) return { behavior: 'allow' };

    const patternAsk = allRules.find(
      (rule) => rule.behavior === 'ask' && (rule.content === null || matcher(rule.content)),
    );
    if (patternAsk) return { behavior: 'ask' };
  }

  return undefined;
}

function resolveVirtualToolName(tool: Parameters<CanUseTool>[0], input: unknown): string | null {
  if (!tool.virtualToolName) return null;
  try {
    return tool.virtualToolName(input);
  } catch {
    return null;
  }
}

async function prepareMatcher(
  tool: Parameters<CanUseTool>[0],
  input: unknown,
): Promise<(pattern: string) => boolean> {
  if (!tool.preparePermissionMatcher) return () => false;
  try {
    return await tool.preparePermissionMatcher(input);
  } catch {
    return () => false;
  }
}

function denyFromRule(rule: PermissionRule, source: string): { behavior: 'deny'; reason: string } {
  return {
    behavior: 'deny',
    reason: `matched deny rule ${JSON.stringify(rule.raw)} from ${source}`,
  };
}

function permissionRuleForInput(toolName: string, input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') return `${toolName}(${obj.command})`;
    if (typeof obj.path === 'string') return `${toolName}(${obj.path})`;
    if (typeof obj.pattern === 'string') return `${toolName}(${obj.pattern})`;
  }
  return toolName;
}

function parseAlreadyValidatedSessionRule(raw: string): { tool: string; content: string | null } {
  const open = raw.indexOf('(');
  if (open === -1 || !raw.endsWith(')')) return { tool: raw, content: null };
  const content = raw.slice(open + 1, -1);
  return { tool: raw.slice(0, open), content: content.length > 0 ? content : null };
}

function passThroughFields(r: {
  updatedInput?: unknown;
  reason?: string;
}): { updatedInput?: unknown; reason?: string } {
  const out: { updatedInput?: unknown; reason?: string } = {};
  if (r.updatedInput !== undefined) out.updatedInput = r.updatedInput;
  if (r.reason !== undefined) out.reason = r.reason;
  return out;
}
