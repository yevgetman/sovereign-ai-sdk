// Phase A T3 — Bearer auth middleware for the native HTTP+SSE protocol.
//
// bearerAuth returns 401 with a JSON error body when the Authorization
// header is missing, malformed, or doesn't match `token`. Constant-time
// compare prevents timing attacks; the token is never logged. /health is
// mounted outside this middleware; the gateway gates /sessions/* with it
// (see buildAppWithRuntime). Mirrors src/openai/auth.ts.

import type { MiddlewareHandler } from 'hono';

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    const presented = match?.[1] ?? '';
    if (!presented || !timingSafeEqual(presented, token)) {
      return c.json(
        {
          error: {
            message: 'Unauthorized — missing or invalid bearer token',
            type: 'unauthorized',
            code: 'unauthorized',
          },
        },
        401,
      );
    }
    await next();
    return;
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
