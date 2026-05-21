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
import { getOrCreateBus } from '../eventBus.js';
import type { Runtime } from '../runtime.js';
import { isValidSessionId } from '../sessionId.js';

export function cancelRoute(_runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/cancel', (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const bus = getOrCreateBus(sessionId);
    const cancelled = bus.cancelCurrentTurn();
    return c.json({ cancelled });
  });

  return r;
}
