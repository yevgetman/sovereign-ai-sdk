// Phase 16.1 M6 T5 — explicit-compaction route.
//
// POST /sessions/:id/compact — synchronous (M6-03). The user is asking for
// compaction now; we run it inline, await runtime.compact(), and return the
// JSON CompactResult on success. There is no SSE involved on this path —
// the caller (TUI /compact slash command, scripts, future automation) gets
// a single HTTP response and pivots subsequent requests onto activeSessionId.
//
// Response codes:
//   200 — { activeSessionId, parentSessionId, summary,
//           estimatedBeforeTokens, estimatedAfterTokens, usedAuxiliary }
//   400 — invalid session id shape (matches sessions.ts validation):
//          body `{ error: 'invalid session id' }`
//   404 — valid-shaped id but not in sessionDb:
//          body `{ error: 'not found' }` (matches sessions.ts envelope —
//          sibling routes return the same shape, no echoed sessionId)
//   500 — runtime.compact() threw (summarizer failure, db write failure,
//          auxiliary 429, etc.); body `{ error: <message> }`
//
// Why parentSessionId is on the response (not in the wire SSE event):
// the TUI invokes this route directly — having the input id echoed back
// lets the dispatch handler pivot without remembering which URL it called.
// The SSE compaction_complete event already carries it as the wire-level
// `sessionId` (the bus is keyed on parent), so it's not needed there.
//
// The proactive (T3) and overflow-recovery (T4) compactions publish a
// `compaction_complete` SSE event via publishCompactionComplete(); this
// route does NOT — there's no per-session bus subscription tied to a
// /compact HTTP call, and the JSON response carries the same payload.

import { Hono } from 'hono';
import type { Runtime } from '../runtime.js';
import { isValidSessionId, loadHistoryAsMessages } from '../sessionId.js';

export function compactRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/compact', async (c) => {
    const sessionId = c.req.param('id');
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const session = runtime.sessionDb.getSession(sessionId);
    if (session === null) {
      // Align with sessions.ts (:41, :54) — same wire shape across sibling
      // routes. The TUI / scripts already know which sessionId they POSTed
      // against, so echoing it back was redundant.
      return c.json({ error: 'not found' }, 404);
    }

    // Shared helper with the turns route (sessionId.ts:loadHistoryAsMessages)
    // so the model's pre-compaction view stays aligned with the turn-time
    // view. Any future signature change (column additions, content-shape
    // migrations) updates exactly one place.
    const history = loadHistoryAsMessages(runtime.sessionDb, sessionId);

    try {
      // c.req.raw.signal aborts on client disconnect (matches the events
      // route at events.ts:23) so a runaway summarize call is cancellable.
      // For in-process app.request() callers (tests, future programmatic
      // use) the signal is a never-aborted AbortSignal and the call runs
      // to completion.
      const result = await runtime.compact(history, sessionId, c.req.raw.signal);
      return c.json({
        activeSessionId: result.newSessionId,
        parentSessionId: result.parentSessionId,
        summary: result.summary,
        estimatedBeforeTokens: result.estimatedBeforeTokens,
        estimatedAfterTokens: result.estimatedAfterTokens,
        usedAuxiliary: result.usedAuxiliary,
      });
    } catch (err) {
      // Surface the failure as JSON so the TUI can render a useful message.
      // 500 (not 4xx) — the request was well-formed; the failure is in the
      // summarizer or downstream sessionDb write.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return r;
}
