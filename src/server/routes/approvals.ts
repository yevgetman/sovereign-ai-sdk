// Phase 16.1 M5 — permission approvals route.
//
// POST /sessions/:id/approvals/:requestId — body { approved, updatedInput? }
// Resolves a pending ApprovalQueue entry keyed by `requestId`. The session
// id in the path is informational (it lets future multi-session servers
// scope approvals); v1 has one session and one ApprovalQueue per Runtime.
//
// Response codes:
//   200 — request resolved; body { ok: true }
//   400 — body missing/invalid; `approved` must be a boolean
//   404 — requestId unknown or already resolved/expired

import { Hono } from 'hono';
import type { Runtime } from '../runtime.js';

export function approvalsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/approvals/:requestId', async (c) => {
    const requestId = c.req.param('requestId');
    // 404 BEFORE parsing the JSON body: an unknown / expired requestId is
    // the common shape of a late client retry, and we don't want to spend
    // the body-parse work on a request whose answer is fixed.
    if (!runtime.approvalQueue.hasPending(requestId)) {
      return c.json({ error: 'unknown or expired requestId' }, 404);
    }
    const body = (await c.req.json()) as {
      approved?: unknown;
      updatedInput?: unknown;
    };
    // Strict boolean check — accept only `true` / `false`, not truthy values.
    if (typeof body.approved !== 'boolean') {
      return c.json({ error: '`approved` is required (boolean)' }, 400);
    }
    runtime.approvalQueue.resolve(requestId, {
      approved: body.approved,
      ...(body.updatedInput !== undefined ? { updatedInput: body.updatedInput } : {}),
    });
    return c.json({ ok: true });
  });

  return r;
}
