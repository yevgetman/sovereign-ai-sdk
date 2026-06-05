// Phase A T4 — configurable CORS for the native HTTP+SSE protocol.
//
// corsMiddleware wraps Hono's built-in `cors` with an explicit allow-list.
// For a request whose Origin is in `origins`, the matched origin is echoed
// back in Access-Control-Allow-Origin (never `*` — the protocol uses the
// Authorization + Last-Event-ID headers, which a wildcard ACAO can't carry
// alongside credentials). Listed origins also get GET/POST/OPTIONS methods,
// the Authorization/Content-Type/Last-Event-ID request headers, and a 204
// short-circuit on preflight OPTIONS. Non-listed origins get no ACAO header.
// Mounted BEFORE bearer auth in buildAppWithRuntime so browsers can preflight
// (OPTIONS carries no Authorization header). The no-corsOrigins default never
// constructs this middleware, so the gateway stays byte-unchanged.

import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

export function corsMiddleware(origins: string[]): MiddlewareHandler {
  const allow = new Set(origins);
  return cors({
    // Echo the matched origin (or undefined → no ACAO) instead of `*`.
    origin: (origin) => (allow.has(origin) ? origin : undefined),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'],
  });
}
