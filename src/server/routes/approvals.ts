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

import type { PostApprovalRequest, PostApprovalResponse } from '@yevgetman/sov-protocol';
import { Hono } from 'hono';
import type { AppVariables } from '../auth.js';
import type { Runtime } from '../runtime.js';
import { isValidSessionId } from '../sessionId.js';
import { loadOwnedSession } from './ownership.js';

export function approvalsRoute(runtime: Runtime): Hono<{ Variables: AppVariables }> {
  const r = new Hono<{ Variables: AppVariables }>();

  r.post('/sessions/:id/approvals/:requestId', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const requestId = c.req.param('requestId');
    // Server-side requestIds are UUIDs from crypto.randomUUID() which conform
    // to SESSION_ID_PATTERN. Reusing isValidSessionId keeps validation aligned
    // with sibling routes (sessions.ts) and prevents empty-string keys from
    // probing the queue map.
    if (!isValidSessionId(requestId)) {
      return c.json({ error: 'invalid request id' }, 400);
    }
    // Phase E T4 — owner-only access. Resolve the session through the shared
    // ownership chokepoint BEFORE touching the approval queue: a session owned
    // by another principal (or unowned, when the caller is a real principal) is
    // hidden as non-existent → 404 (existence-hiding; never 403), so bob can't
    // resolve / probe a pending approval on alice's session. Implicit/null
    // owner sees all (back-compat).
    if (loadOwnedSession(runtime, c, sessionId) === null) {
      return c.json({ error: 'not found' }, 404);
    }
    // 404 BEFORE parsing the JSON body: an unknown / expired requestId is
    // the common shape of a late client retry, and we don't want to spend
    // the body-parse work on a request whose answer is fixed.
    if (!runtime.approvalQueue.hasPending(requestId)) {
      return c.json({ error: 'unknown or expired requestId' }, 404);
    }
    // Guard the body parse: a malformed/empty body makes `c.req.json()`
    // throw, which Hono surfaces as an HTTP 500 text/plain response.
    // Mirror the structured 400 every other body-reading route returns.
    // The 404-before-parse guard above still pre-empts this for unknown
    // requestIds; this only covers the valid-pending-requestId case.
    let body: PostApprovalRequest;
    try {
      body = (await c.req.json()) as PostApprovalRequest;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    // Strict boolean check — accept only `true` / `false`, not truthy values.
    if (typeof body.approved !== 'boolean') {
      return c.json({ error: '`approved` is required (boolean)' }, 400);
    }
    // `always` is optional. When present it must be a boolean — we only
    // forward it to the queue when explicitly true so the ApprovalResponse
    // keeps the field undefined for "allow" / "deny" answers (no truthy
    // coercion; matches the strict shape used for `approved`).
    if (body.always !== undefined && typeof body.always !== 'boolean') {
      return c.json({ error: '`always` must be a boolean when provided' }, 400);
    }
    runtime.approvalQueue.resolve(requestId, {
      approved: body.approved,
      ...(body.always === true ? { always: true } : {}),
      ...(body.updatedInput !== undefined ? { updatedInput: body.updatedInput } : {}),
    });
    return c.json({ ok: true } satisfies PostApprovalResponse);
  });

  return r;
}
