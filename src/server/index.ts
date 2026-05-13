// Public boot entry for the Phase 16.1 HTTP+SSE server.
//
// startServer(opts) picks a free port on 127.0.0.1, mounts the Hono app
// (with or without a runtime), returns a { port, stop } handle. The TUI
// launcher passes runtime; M1 boot tests pass no runtime and exercise
// the health-only flavor.

import { buildApp, buildAppWithRuntime } from './app.js';
import { findFreePort } from './port.js';
import type { Runtime } from './runtime.js';

export type StartServerOptions = {
  /** Override the random-port pick (testing / explicit-port modes). */
  port?: number;
  /** When provided, mounts the M3+ surface (sessions, turns, events). */
  runtime?: Runtime;
};

export type StartedServer = {
  port: number;
  stop: () => Promise<void>;
};

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const port = opts.port ?? (await findFreePort());
  const app = opts.runtime ? buildAppWithRuntime(opts.runtime) : buildApp();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });
  const boundPort = server.port;
  if (typeof boundPort !== 'number') {
    throw new Error('Bun.serve did not return a numeric port');
  }
  return {
    port: boundPort,
    stop: async () => {
      server.stop();
    },
  };
}
