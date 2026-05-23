// Phase 18 T1 — Bun.serve boot for the OpenAI-compatible API.
//
// createOpenAIServer boots a Bun.serve instance with the OpenAI HTTP
// API mounted. Returns a handle for the caller (sov serve) to track
// the bound port and gracefully stop on SIGINT/SIGTERM. idleTimeout: 0
// matches the TUI server pattern — long-running SSE streams (added in
// later tasks for /v1/chat/completions with stream: true) must not be
// killed by an idle timer.

import type { Runtime } from '../server/runtime.js';
import { buildOpenAIApp } from './app.js';

export type OpenAIServerOpts = {
  runtime: Runtime;
  apiKey: string;
  port: number;
  host?: string;
};

export type OpenAIServerHandle = {
  port: number;
  host: string;
  stop: () => Promise<void>;
};

export function createOpenAIServer(opts: OpenAIServerOpts): OpenAIServerHandle {
  const host = opts.host ?? '127.0.0.1';
  const app = buildOpenAIApp({ runtime: opts.runtime, apiKey: opts.apiKey });
  const server = Bun.serve({
    port: opts.port,
    hostname: host,
    fetch: app.fetch,
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
    host,
    stop: async () => {
      server.stop();
    },
  };
}
