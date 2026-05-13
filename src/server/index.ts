// Public boot entry for the Phase 16.1 HTTP+SSE server.
//
// startServer(opts) picks a free port on 127.0.0.1, mounts the Hono app,
// returns a { port, stop } handle. Single-server-per-process by design;
// callers that want multi-process isolation spawn separate sov runtimes.

import { buildApp } from './app.js';
import { findFreePort } from './port.js';

export type StartServerOptions = {
  /** Override the random-port pick (testing / explicit-port modes). */
  port?: number;
};

export type StartedServer = {
  port: number;
  stop: () => Promise<void>;
};

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const port = opts.port ?? (await findFreePort());
  const app = buildApp();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });
  return {
    port: server.port,
    stop: async () => {
      server.stop();
    },
  };
}
