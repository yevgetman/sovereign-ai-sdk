// Public boot entry for the Phase 16.1 HTTP+SSE server.
//
// startServer(opts) picks a free port on 127.0.0.1, mounts the Hono app
// (with or without a runtime), returns a { port, stop } handle. The TUI
// launcher passes runtime; M1 boot tests pass no runtime and exercise
// the health-only flavor.

import { buildApp, buildAppWithRuntime } from './app.js';
import { findFreePort, resolveBindHost } from './port.js';
import type { SessionSupervisorLike } from './routes/sessions.js';
import type { Runtime } from './runtime.js';

export type StartServerOptions = {
  /** Override the random-port pick (testing / explicit-port modes). */
  port?: number;
  /** Bind host. Defaults to loopback (127.0.0.1) so the TUI launcher,
   *  `sov serve`, and `sov drive` are byte-unchanged; the later
   *  `sov gateway` passes an explicit (possibly off-loopback) host. */
  hostname?: string;
  /** When provided, mounts the M3+ surface (sessions, turns, events). */
  runtime?: Runtime;
  /** Phase A `sov gateway` — opts the session routes into bearer-token
   *  auth. Forwarded to buildAppWithRuntime; unset leaves the app
   *  byte-unchanged so the TUI launcher, `sov serve`, and `sov drive`
   *  stay credential-free. */
  auth?: string;
  /** Phase A `sov gateway` — CORS allow-list of browser origins for
   *  cross-origin clients. Forwarded to buildAppWithRuntime; unset
   *  never constructs the CORS middleware (byte-unchanged). */
  corsOrigins?: string[];
  /** Phase D `sov gateway` — SessionSupervisor that gates POST /sessions with
   *  a concurrency cap. Forwarded to buildAppWithRuntime; unset leaves the cap
   *  disabled so the TUI / `sov serve` / `sov drive` create path is unchanged. */
  supervisor?: SessionSupervisorLike;
  /** Phase E `sov gateway` — per-principal bearer auth registry. Forwarded to
   *  buildAppWithRuntime; mutually exclusive with `auth`. When set, the session
   *  routes require a token resolving to a registered principal (no anonymous
   *  bypass); unset leaves the auth/open behavior byte-unchanged. */
  principals?: ReadonlyArray<{ id: string; token: string; name?: string | undefined }>;
};

export type StartedServer = {
  port: number;
  stop: () => Promise<void>;
};

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const hostname = resolveBindHost(opts.hostname);
  const port = opts.port ?? (await findFreePort(hostname));
  // Only construct the app-opts object when the gateway actually passes
  // auth/CORS/supervisor/principals — keeps the TUI/serve/drive paths calling
  // buildAppWithRuntime(runtime) with no second arg (byte-unchanged).
  const appOpts =
    opts.auth !== undefined ||
    opts.corsOrigins !== undefined ||
    opts.supervisor !== undefined ||
    opts.principals !== undefined
      ? {
          ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
          ...(opts.corsOrigins !== undefined ? { corsOrigins: opts.corsOrigins } : {}),
          ...(opts.supervisor !== undefined ? { supervisor: opts.supervisor } : {}),
          ...(opts.principals !== undefined ? { principals: opts.principals } : {}),
        }
      : undefined;
  const app = opts.runtime
    ? appOpts
      ? buildAppWithRuntime(opts.runtime, appOpts)
      : buildAppWithRuntime(opts.runtime)
    : buildApp();
  const server = Bun.serve({
    port,
    hostname,
    fetch: app.fetch,
    // SSE responses are long-lived; the application layer owns lifecycle
    // via abort signals and turn_complete events. Bun's default 10s
    // idleTimeout was killing /sessions/:id/events streams when real
    // Anthropic took longer than 10s to emit the first text_delta — the
    // M4 manual smoke caught this. 0 disables the per-connection timer.
    idleTimeout: 0,
  });
  const boundPort = server.port;
  if (typeof boundPort !== 'number') {
    throw new Error(
      `Bun.serve returned non-numeric port: ${typeof boundPort} ${String(boundPort)}`,
    );
  }
  return {
    port: boundPort,
    stop: async () => {
      server.stop();
    },
  };
}
