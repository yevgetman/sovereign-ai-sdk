// ux-fixes round 4 — POST /sessions/:id/cancel.
//
// Aborts the active turn (if any) WITHOUT disposing the bus or the
// session. The TUI hits this endpoint when the user presses ESC during
// a streaming turn — the equivalent of Claude Code's ESC = stop-agent
// behavior. The server-side turn loop's AbortSignal.any combines this
// per-turn controller with the bus-level controller; aborting only
// the per-turn controller leaves the bus subscribed and ready for the
// next POST /turns.
//
// Response shape:
//   200 { cancelled: true }   — a turn was active and its controller fired
//   200 { cancelled: false }  — no turn was active; idempotent no-op
//   400 { error: ... }        — malformed session id
//
// We deliberately do NOT 404 on "no bus" — calling cancel on a
// non-existent session is harmless and getOrCreateBus's side effect
// of allocating an empty bus is also harmless (gets cleaned up on
// disposeBus). Returning success-with-`cancelled: false` keeps the
// TUI's client-side logic simple (no special-case handling for the
// "I clicked ESC twice fast" race).

import { Hono } from 'hono';
import type { CancelTurnResponse } from '../../protocol/index.js';
import type { AppVariables } from '../auth.js';
import { getOrCreateBus } from '../eventBus.js';
import type { Runtime } from '../runtime.js';
import { isValidSessionId } from '../sessionId.js';
import { loadOwnedSession, ownerIdOf } from './ownership.js';

export function cancelRoute(runtime: Runtime): Hono<{ Variables: AppVariables }> {
  const r = new Hono<{ Variables: AppVariables }>();

  r.post('/sessions/:id/cancel', (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    // Phase E T4 — owner-only access. When the caller is a real principal, a
    // session it doesn't own (or an unowned/non-existent one) is hidden as
    // non-existent → 404 (existence-hiding; never 403), BEFORE getOrCreateBus so
    // bob can't mint a bus / cancel a turn on alice's session. The implicit/null
    // owner path is left byte-identical to the documented open-mode behavior:
    // cancel on a non-existent session is a harmless idempotent no-op (returns
    // `{ cancelled: false }`), NOT a 404 — so the loopback TUI's ESC handling is
    // unchanged. (We only short-circuit when a principal is present.)
    if (ownerIdOf(c) !== null && loadOwnedSession(runtime, c, sessionId) === null) {
      return c.json({ error: 'not found' }, 404);
    }
    const bus = getOrCreateBus(sessionId);
    const cancelled = bus.cancelCurrentTurn();
    return c.json({ cancelled } satisfies CancelTurnResponse);
  });

  return r;
}
