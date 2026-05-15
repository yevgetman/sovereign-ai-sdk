// Hono app composition for the Phase 16.1 HTTP+SSE server.
//
// buildApp() is the health-only flavor used by boot tests that don't need
// a runtime. buildAppWithRuntime() is the M3+ surface — it mounts every
// route that needs the runtime (sessions, turns) plus the SSE stream.

import { Hono } from 'hono';
import { approvalsRoute } from './routes/approvals.js';
import { compactRoute } from './routes/compact.js';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';
import { sessionsRoute } from './routes/sessions.js';
import { turnsRoute } from './routes/turns.js';
import type { Runtime } from './runtime.js';

export function buildApp(): Hono {
  // Health-only app for boot tests (no runtime). M3+ callers use
  // buildAppWithRuntime to mount the full surface.
  const app = new Hono();
  app.route('/', healthRoute);
  return app;
}

export function buildAppWithRuntime(runtime: Runtime): Hono {
  const app = new Hono();
  app.route('/', healthRoute);
  app.route('/', sessionsRoute(runtime));
  app.route('/', turnsRoute(runtime));
  app.route('/', approvalsRoute(runtime));
  app.route('/', compactRoute(runtime));
  app.route('/', eventsRoute);
  return app;
}
