// canUseTool — the orchestrator-level permission decider. Wraps the tool's
// own checkPermissions() with the REPL's mode + asker + always-cache. The
// orchestrator calls this before every tool dispatch; a 'deny' result
// becomes an is_error tool_result without invoking tool.call().
//
// Phase 3 scope: mode is 'ask' or 'bypass'; always-cache is keyed by tool
// name (crude but sufficient — Phase 7 replaces with rule-based matching).
// updatedInput on the tool's self-check passes through (typed-in but
// Phase 3 orchestrator ignores it; Phase 7 re-validates and swaps).

import { previewToolInput } from './prompt.js';
import type { AskUser, CanUseTool, PermissionMode } from './types.js';

export type BuildCanUseToolOpts = {
  mode: PermissionMode;
  ask: AskUser;
  /** Mutated when the user answers 'always' for a tool. Caller owns the Set
   *  so it can inspect, reset, or seed (e.g. future plan-mode presets). */
  alwaysAllow: Set<string>;
};

export function buildCanUseTool(opts: BuildCanUseToolOpts): CanUseTool {
  return async (tool, input, ctx) => {
    if (opts.mode === 'bypass') return { behavior: 'allow' };
    if (opts.alwaysAllow.has(tool.name)) return { behavior: 'allow' };

    const selfCheck = await tool.checkPermissions(input, ctx);
    if (selfCheck.behavior === 'allow') {
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
      opts.alwaysAllow.add(tool.name);
      return { behavior: 'allow' };
    }
    if (answer === 'allow') return { behavior: 'allow' };
    return { behavior: 'deny', reason: 'user denied' };
  };
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
