// Phase 18 T1 — OpenAI-compatible HTTP app constructor.
//
// buildOpenAIApp constructs the OpenAI-compatible HTTP API surface.
// /health is mounted unauthenticated (probe-friendly). All /v1/* routes
// will be added in later tasks behind bearerAuth(apiKey).

import { Hono } from 'hono';
import type { Runtime } from '../server/runtime.js';
import { healthRoute } from './routes/health.js';

export type OpenAIAppOpts = {
  runtime: Runtime;
  apiKey: string;
};

export function buildOpenAIApp(opts: OpenAIAppOpts): Hono {
  const app = new Hono();
  app.route('/', healthRoute);
  // /v1/* — gated by bearerAuth(opts.apiKey) — added in T2+. The
  // runtime + apiKey will be consumed by /v1/* routes; this is the
  // skeleton commit. Tests verify /health works without auth.
  // `void opts` silences strict-mode noUnusedParameters until T2 wires
  // the real routes.
  void opts;
  return app;
}
