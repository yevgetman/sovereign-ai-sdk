// Phase 16.1 M3.4 — sessions route.
//
// POST   /sessions — create a fresh session row in the runtime's SessionDb.
// GET    /sessions — list sessions with live/turnActive/subscribers annotations (Phase D T4).
// GET    /sessions/:id — fetch session metadata.
// GET    /sessions/:id/messages — fetch the stored message backlog (M4 Task 3).
// DELETE /sessions/:id — tear down + permanently delete a session (Phase D T4).
//
// M3 records model/provider/system-prompt on creation so the row is
// well-formed and downstream observability (cost accounting, resume)
// can hang off it in later milestones.
//
// M4 Task 3 adds the messages endpoint. The TUI calls it once on Init()
// to hydrate the transcript with prior conversation history before
// subscribing to the SSE event stream. Hydrate-then-subscribe keeps the
// SSE stream lean for live events and lets the HTTP fetch be retried
// independently.
//
// Phase D T4 adds the management surface a long-lived gateway needs: a
// session list (annotated with live in-memory state) and per-session delete.
// POST /sessions gains an optional concurrency cap: when a supervisor is
// threaded in, the route refuses (429) once the live session count is at the
// configured ceiling and a sweep can't free room. The cap is entirely opt-in —
// absent supervisor ⇒ byte-unchanged create behavior — so the TUI / `sov serve`
// / `sov drive` paths (which build the app without a supervisor) are untouched.

import { Hono } from 'hono';
import { disposeBus, peekBus } from '../eventBus.js';
import type { Runtime } from '../runtime.js';
import { isValidSessionId } from '../sessionId.js';

/** Upper bound on the `?limit` query param for GET /sessions. */
const MAX_LIST_LIMIT = 100;

/**
 * Minimal structural view of the SessionSupervisor that POST /sessions needs
 * for its concurrency cap. Kept structural (not the concrete class) so the
 * route + app stay decoupled from the supervisor module and tests/non-gateway
 * servers can omit or fake it. `getMaxConcurrentSessions` returns `undefined`
 * when no cap is configured; `liveSessionCount` is the current count of live
 * in-memory sessions; `sweep` reclaims idle sessions and resolves once done.
 */
export interface SessionSupervisorLike {
  liveSessionCount(): number;
  sweep(): Promise<unknown>;
  getMaxConcurrentSessions(): number | undefined;
}

export function sessionsRoute(runtime: Runtime, supervisor?: SessionSupervisorLike): Hono {
  const r = new Hono();

  r.post('/sessions', async (c) => {
    // Concurrency cap (opt-in). Only enforced when a supervisor is wired in
    // AND it reports a positive ceiling. At/over the ceiling we first sweep
    // idle sessions, then re-check: if the sweep freed room the request is
    // admitted, otherwise we refuse with 429. Absent supervisor or max <= 0
    // ⇒ no cap (byte-unchanged create path below).
    if (supervisor !== undefined) {
      const max = supervisor.getMaxConcurrentSessions();
      if (typeof max === 'number' && max > 0 && supervisor.liveSessionCount() >= max) {
        await supervisor.sweep();
        if (supervisor.liveSessionCount() >= max) {
          return c.json({ error: 'session capacity reached' }, 429);
        }
      }
    }
    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      systemPrompt: runtime.systemSegments,
      metadata: {
        cwd: runtime.cwd,
        ...(runtime.bundleRoot !== undefined ? { bundleRoot: runtime.bundleRoot } : {}),
      },
    });
    return c.json({ sessionId, createdAt: new Date().toISOString() }, 201);
  });

  r.get('/sessions', (c) => {
    // Optional ?limit, clamped to [1, MAX_LIST_LIMIT]; falls back to the
    // SessionDb default (20) when absent or unparseable.
    const raw = c.req.query('limit');
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
    const limit = Number.isInteger(parsed)
      ? Math.min(Math.max(parsed, 1), MAX_LIST_LIMIT)
      : undefined;
    const entries =
      limit !== undefined
        ? runtime.sessionDb.listSessions(limit)
        : runtime.sessionDb.listSessions();
    // Annotate each row IMMUTABLY with live in-memory state. peekBus never
    // mints a bus on a miss, so a session with no live bus reads as
    // live:false / turnActive:false / subscribers:0.
    const sessions = entries.map((entry) => {
      const bus = peekBus(entry.sessionId);
      return {
        ...entry,
        live: bus !== undefined,
        turnActive: bus?.isTurnActive() ?? false,
        subscribers: bus?.getSubscriberCount() ?? 0,
      };
    });
    return c.json({ sessions });
  });

  r.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
    const session = runtime.sessionDb.getSession(id);
    if (session === null) return c.json({ error: 'not found' }, 404);
    return c.json({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      model: session.model,
      provider: session.provider,
    });
  });

  r.get('/sessions/:id/messages', (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
    const session = runtime.sessionDb.getSession(id);
    if (session === null) return c.json({ error: 'not found' }, 404);
    const stored = runtime.sessionDb.loadMessages(id);
    // Strip storage-internal fields — callers only need role + content to render.
    const messages = stored.map((m) => ({ role: m.role, content: m.content }));
    return c.json({ messages });
  });

  r.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
    // 404 BEFORE any teardown so a bad/unknown id never mutates state.
    if (runtime.sessionDb.getSession(id) === null) return c.json({ error: 'not found' }, 404);
    // Teardown order: dispose the in-memory session context (no bus arg — no
    // SSE consumer to send a goodbye card to), then dispose the bus, then
    // remove the persisted rows. disposeSession already calls disposeBus, but
    // the explicit call keeps the contract self-evident and is idempotent.
    await runtime.disposeSession(id);
    disposeBus(id);
    runtime.sessionDb.deleteSession(id);
    return c.body(null, 204);
  });

  return r;
}
