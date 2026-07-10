// packages/sdk/src/core/conductToolPolicy.ts — deny-first conduct wrapper
// around the canUseTool cascade (the channel-wrapper composition precedent:
// src/channels/permission.ts). Conduct 'deny' wins outright; any non-deny
// defers to the inner decider unchanged; absent inner + non-deny allows
// (today's ungated default). Runs on EVERY surface — tool floors apply to
// internal turns too (D23). A thrown toolPolicy fails OPEN (defer to inner).

import type { CanUseTool } from '../permissions/types.js';
import { type ConductContext, type ConductProvider, wrapConductAuditSink } from './conductPort.js';

export function composeConductCanUseTool(
  conduct: ConductProvider | undefined,
  ctx: ConductContext,
  inner: CanUseTool | undefined,
): CanUseTool | undefined {
  const policy = conduct?.toolPolicy?.bind(conduct);
  if (!policy) return inner;
  const emitAudit = wrapConductAuditSink(conduct?.auditSink?.bind(conduct));
  return async (tool, input, toolCtx) => {
    const startedAt = Date.now();
    let verdictLabel = 'allow';
    try {
      const verdict = await policy(tool.name, input, ctx);
      if (verdict.behavior === 'deny') {
        verdictLabel = 'deny';
        return {
          behavior: 'deny',
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        };
      }
    } catch {
      verdictLabel = 'error'; // fail open → defer to inner
    } finally {
      emitAudit({
        stage: 'tool',
        sessionId: ctx.sessionId,
        surface: ctx.surface,
        verdict: verdictLabel,
        latencyMs: Date.now() - startedAt,
        iso: new Date().toISOString(),
      });
    }
    if (inner) return inner(tool, input, toolCtx);
    return { behavior: 'allow' };
  };
}
