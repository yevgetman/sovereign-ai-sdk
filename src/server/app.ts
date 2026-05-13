// Hono app composition for the Phase 16.1 HTTP+SSE server.
//
// M1: /health + /sessions/:id/events (hardcoded stream).
// M3 expands: POST /sessions, POST /sessions/:id/turns, etc.

import { Hono } from 'hono';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';

export function buildApp(): Hono {
  const app = new Hono();
  app.route('/', healthRoute);
  app.route('/', eventsRoute);
  return app;
}
