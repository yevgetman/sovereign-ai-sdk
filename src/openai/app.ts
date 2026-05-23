// Phase 18 — OpenAI-compatible HTTP app constructor.
//
// buildOpenAIApp constructs the OpenAI-compatible HTTP API surface.
// /health is mounted unauthenticated (probe-friendly). /v1/* routes are
// gated behind bearerAuth(opts.apiKey). T2 adds /v1/chat/completions
// (non-streaming branch); T5 adds streaming; T7 adds /v1/models.

import { Hono } from 'hono';
import type { Runtime } from '../server/runtime.js';
import { bearerAuth } from './auth.js';
import { chatCompletionsRoute } from './routes/chatCompletions.js';
import { healthRoute } from './routes/health.js';
import { modelsRoute } from './routes/models.js';

export type OpenAIAppOpts = {
  runtime: Runtime;
  apiKey: string;
};

export function buildOpenAIApp(opts: OpenAIAppOpts): Hono {
  const app = new Hono();
  // /health — unauthenticated, probe-friendly.
  app.route('/', healthRoute);
  // /v1/* — gated by bearerAuth(opts.apiKey). All OpenAI-compatible
  // routes mount here. Hono's `app.use('/v1/*', ...)` applies the
  // middleware to every sub-route registered after this line.
  app.use('/v1/*', bearerAuth(opts.apiKey));
  app.route('/', chatCompletionsRoute(opts.runtime));
  app.route('/', modelsRoute(opts.runtime));
  return app;
}
