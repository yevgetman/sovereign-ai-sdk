// Hono app composition for the Phase 16.1 HTTP+SSE server.
//
// buildApp() is the health-only flavor used by boot tests that don't need
// a runtime. buildAppWithRuntime() is the M3+ surface — it mounts every
// route that needs the runtime (sessions, turns) plus the SSE stream.

import { Hono } from 'hono';
import { bearerAuth } from './auth.js';
import { corsMiddleware } from './cors.js';
import { approvalsRoute } from './routes/approvals.js';
import { cancelRoute } from './routes/cancel.js';
import { commandsRoute } from './routes/commands.js';
import { compactRoute } from './routes/compact.js';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';
import { type SessionSupervisorLike, sessionsRoute } from './routes/sessions.js';
import { skillsRoute } from './routes/skills.js';
import { turnsRoute } from './routes/turns.js';
import type { Runtime } from './runtime.js';
import { WEB_UI_HTML } from './webui.js';

export function buildApp(): Hono {
  // Health-only app for boot tests (no runtime). M3+ callers use
  // buildAppWithRuntime to mount the full surface.
  const app = new Hono();
  app.route('/', healthRoute);
  return app;
}

/**
 * Options for the native HTTP+SSE app surface.
 *
 * `auth` opts the gateway into bearer-token auth on the session routes;
 * when unset the app is byte-unchanged (no auth middleware) so the
 * existing TUI / `sov serve` / `sov drive` loopback path keeps working
 * without credentials. `corsOrigins` opts the gateway into CORS for a
 * browser-based web UI on another origin: the matched origin is echoed in
 * Access-Control-Allow-Origin and preflight OPTIONS short-circuits 204. When
 * unset, no CORS middleware is mounted and the app stays byte-unchanged.
 *
 * `supervisor` (Phase D T4) opts POST /sessions into a concurrency cap and is
 * threaded to the sessions route. It's a minimal structural type (not the
 * concrete SessionSupervisor) so app.ts stays decoupled from that module and
 * non-gateway callers (TUI / `sov serve` / `sov drive`) can omit it — absent
 * supervisor ⇒ the cap is disabled and the create path is byte-unchanged.
 */
export type BuildAppOpts = {
  auth?: string;
  corsOrigins?: string[];
  supervisor?: SessionSupervisorLike;
};

export function buildAppWithRuntime(runtime: Runtime, opts?: BuildAppOpts): Hono {
  const app = new Hono();
  // CORS is opt-in and mounted FIRST so it runs for every route and BEFORE
  // bearer auth — browsers preflight with OPTIONS (no Authorization header),
  // which auth would otherwise reject. Listed origins are echoed back; the
  // no-corsOrigins default never constructs this middleware (byte-unchanged).
  if (opts?.corsOrigins?.length) {
    app.use('*', corsMiddleware(opts.corsOrigins));
  }
  // /health is always open (probe-friendly) — mounted before the auth
  // middleware so it stays reachable without credentials.
  app.route('/', healthRoute);
  // The web UI shell is served at GET / and GET /ui. It's just the browser
  // client's HTML — it carries no secret — so it's mounted OPEN, before the
  // bearer-auth middleware, exactly like /health. The session routes below
  // stay gated. The HTML is embedded at build time (see webui.ts).
  app.get('/', (c) => c.html(WEB_UI_HTML));
  app.get('/ui', (c) => c.html(WEB_UI_HTML));
  // Bearer auth is opt-in: only when opts.auth is set do we gate the
  // session routes. `app.use` applies to every route registered after
  // this line, so /health above stays open while everything below
  // (sessions, turns, approvals, commands, …) is protected.
  if (opts?.auth !== undefined) {
    app.use('/sessions/*', bearerAuth(opts.auth));
  }
  app.route('/', sessionsRoute(runtime, opts?.supervisor));
  app.route('/', turnsRoute(runtime));
  app.route('/', approvalsRoute(runtime));
  app.route('/', compactRoute(runtime));
  // ux-fixes round 4 — POST /sessions/:id/cancel, ESC = stop-agent.
  app.route('/', cancelRoute(runtime));
  // M8 T4 — GET /sessions/:id/skills, JSON-only discovery for the TUI.
  app.route('/', skillsRoute(runtime));
  // M10.5 — POST /sessions/:id/commands, generic slash-command dispatcher.
  // Closes M10 audit slice 1 HIGH gap; unblocks M11.
  app.route('/', commandsRoute(runtime));
  app.route('/', eventsRoute);
  return app;
}
