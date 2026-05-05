// InputTransformer — a higher-order layer over CanUseTool that lets
// built-in defense-in-depth (currently: secret redaction) rewrite tool
// inputs after permission resolution but before the orchestrator
// dispatches the tool.
//
// Why a wrapper instead of editing buildCanUseTool: the rule-chain
// machinery in canUseTool.ts is configurable (rule layers from session/
// project/user). Transformers are compile-time wired into the harness as
// safety properties. Keeping them separate keeps the rule chain focused
// on allow/deny/ask, and the transformer chain focused on rewrite.
//
// Multiple transformers compose left-to-right: each receives the input
// the previous one produced. Reasons concatenate with `; `.

import type { Tool } from '../tool/types.js';
import type { CanUseTool, ResolvedPermissionResult } from './types.js';

export type InputTransformer = (
  tool: Tool<unknown, unknown>,
  input: unknown,
) => Promise<{ updatedInput?: unknown; reason?: string } | undefined>;

/**
 * Wrap an existing CanUseTool with one or more InputTransformers. After
 * the underlying canUseTool resolves to `allow`, each transformer runs
 * in turn against the (possibly already-updated) input. Transformer
 * outputs merge: `updatedInput` is overwritten by each non-undefined
 * value; `reason` strings concatenate.
 *
 * If the underlying canUseTool resolves to `deny`, transformers are
 * skipped — there's nothing to dispatch.
 */
export function wrapCanUseToolWithTransformers(
  base: CanUseTool,
  transformers: readonly InputTransformer[],
): CanUseTool {
  if (transformers.length === 0) return base;
  return async (tool, input, ctx): Promise<ResolvedPermissionResult> => {
    const perm = await base(tool, input, ctx);
    if (perm.behavior === 'deny') return perm;

    let current: unknown = perm.updatedInput !== undefined ? perm.updatedInput : input;
    let mutated = perm.updatedInput !== undefined;
    const reasons: string[] = [];
    if (perm.reason !== undefined) reasons.push(perm.reason);

    for (const transformer of transformers) {
      let out: Awaited<ReturnType<InputTransformer>>;
      try {
        out = await transformer(tool, current);
      } catch {
        // A transformer crash must not block tool execution; skip it.
        continue;
      }
      if (!out) continue;
      if (out.updatedInput !== undefined) {
        current = out.updatedInput;
        mutated = true;
      }
      if (out.reason !== undefined) reasons.push(out.reason);
    }

    return {
      behavior: 'allow',
      ...(mutated ? { updatedInput: current } : {}),
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    };
  };
}
