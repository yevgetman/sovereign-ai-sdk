// Phase 16.1 M3.4 — sessions route.
//
// POST /sessions — create a fresh session row in the runtime's SessionDb.
// GET  /sessions/:id — fetch session metadata.
// GET  /sessions/:id/messages — fetch the stored message backlog (M4 Task 3).
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

import { Hono } from 'hono';
import type { Runtime } from '../runtime.js';
import { isValidSessionId } from '../sessionId.js';

export function sessionsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions', (c) => {
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

  return r;
}
