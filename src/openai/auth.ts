// Phase 18 T1 — Bearer auth middleware for the OpenAI-compatible API.
//
// bearerAuth returns 401 with an OpenAI-shaped error body when the
// Authorization header is missing, malformed, or doesn't match
// expectedKey. Constant-time compare prevents timing attacks on the
// key. The /health route is mounted outside this middleware; all
// /v1/* routes go through it (mounted in T2+).

import type { MiddlewareHandler } from 'hono';

export function bearerAuth(expectedKey: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    const presented = match?.[1] ?? '';
    if (!presented || !timingSafeEqual(presented, expectedKey)) {
      return c.json(
        {
          error: {
            message: 'Unauthorized — missing or invalid API key',
            type: 'invalid_api_key',
            code: 'invalid_api_key',
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
