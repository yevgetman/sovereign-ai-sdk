// Hono app composition for the Phase 16.1 HTTP+SSE server.
//
// buildApp() is the health-only flavor used by boot tests that don't need
// a runtime. buildAppWithRuntime() is the M3+ surface — it mounts every
// route that needs the runtime (sessions, turns) plus the SSE stream.

import { Hono } from 'hono';
import { type AppVariables, bearerAuth, principalAuth } from './auth.js';
import { corsMiddleware } from './cors.js';
import { approvalsRoute } from './routes/approvals.js';
import { cancelRoute } from './routes/cancel.js';
import { type ChannelsConfig, type ChannelsDeps, channelsRoute } from './routes/channels.js';
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
 *
 * `principals` (Phase E T2) opts the session routes into per-principal
 * bearer auth and is mutually exclusive with `auth` (the config enforces the
 * exclusion). When set it gates /sessions/* with principalAuth INSTEAD of
 * bearerAuth — every request needs a token resolving to a registered
 * principal (no anonymous bypass). When unset, the auth/open behavior is
 * byte-unchanged.
 *
 * `channels` (Phase F T4) opts in the inbound channel routes (webhook v1).
 * When set, channelsRoute is mounted OPEN — before the /sessions/* auth, like
 * /health and GET / — because a channel request authenticates via its OWN
 * transport credential (the webhook HMAC), not the gateway bearer/principal
 * token. When unset, no channel route is mounted (byte-unchanged).
 */
export type BuildAppOpts = {
  auth?: string;
  corsOrigins?: string[];
  supervisor?: SessionSupervisorLike;
  principals?: ReadonlyArray<{ id: string; token: string; name?: string | undefined }>;
  channels?: ChannelsConfig;
  /** The boot-time directive-overlay intake result (see decorumAdapter). When
   *  present, GET /conduct/overlay serves it so the host can tell a user which of
   *  their directives decorum refused. Content-free: counts + reason codes only.
   *  Absent ⇒ the route is not mounted (byte-unchanged). */
  overlayIntake?: { accepted: number; rejected: readonly unknown[] };
};

export function buildAppWithRuntime(
  runtime: Runtime,
  opts?: BuildAppOpts,
  channelsDeps?: ChannelsDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
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
  // Phase F T4 — inbound channel routes (webhook v1). Mounted OPEN, before the
  // /sessions/* auth below, because a channel request authenticates via its own
  // transport credential (the webhook HMAC) rather than the gateway
  // bearer/principal token. Only constructed when channels are configured; the
  // route itself 404s any unknown / disabled channel id. Absent ⇒ no route
  // mounted (byte-unchanged for TUI / `sov serve` / `sov drive`).
  if (opts?.channels !== undefined) {
    app.route('/', channelsRoute(runtime, opts.channels, channelsDeps));
  }
  // Session-route auth is opt-in. `app.use` applies to every route
  // registered after this line, so /health and / + /ui above stay open
  // while everything below (sessions, turns, approvals, commands, …) is
  // gated. Precedence: principals (multi-user) > single-token > open. The
  // two auth modes are mutually exclusive (the config enforces it); when
  // neither is set the session routes stay open (byte-unchanged loopback
  // path for TUI / `sov serve` / `sov drive`).
  if (opts?.principals !== undefined) {
    app.use('/sessions/*', principalAuth(opts.principals));
    app.use('/conduct/*', principalAuth(opts.principals));
  } else if (opts?.auth !== undefined) {
    app.use('/sessions/*', bearerAuth(opts.auth));
    app.use('/conduct/*', bearerAuth(opts.auth));
  }
  // GET /conduct/overlay — the boot-time intake verdict for this gateway's
  // directive overlay. Mounted ONLY when an overlay was bound, and gated by the
  // same auth as the session routes (it is tenant-scoped operational state). The
  // payload is content-free by construction: decorum's rejections carry a
  // channel, an index, and a reason code — never the tenant's directive text.
  // A host surfaces this so a refused rule (e.g. one that read as prompt
  // injection) is reported to the user instead of silently never applying.
  const intake = opts?.overlayIntake;
  if (intake !== undefined) {
    app.get('/conduct/overlay', (c) =>
      c.json({ accepted: intake.accepted, rejected: intake.rejected }),
    );
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
  app.route('/', eventsRoute(runtime));
  return app;
}
