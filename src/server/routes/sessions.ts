// Phase 16.1 M3.4 — sessions route.
//
// POST /sessions — create a fresh session row in the runtime's SessionDb.
// GET  /sessions/:id — fetch session metadata.
//
// M3 records model/provider/system-prompt on creation so the row is
// well-formed and downstream observability (cost accounting, resume)
// can hang off it in later milestones.

import { Hono } from 'hono';
import type { Runtime } from '../runtime.js';

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
    const session = runtime.sessionDb.getSession(id);
    if (session === null) return c.json({ error: 'not found' }, 404);
    return c.json({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      model: session.model,
      provider: session.provider,
    });
  });

  return r;
}
