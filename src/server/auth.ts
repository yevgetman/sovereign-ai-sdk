// Phase A T3 — Bearer auth middleware for the native HTTP+SSE protocol.
// Phase E T2 — principal-aware variant (token→principal; no anonymous bypass).
//
// bearerAuth (single-token, legacy) returns 401 with a JSON error body when
// the Authorization header is missing, malformed, or doesn't match `token`.
// principalAuth (multi-user) resolves the presented token to a principal and
// 401s when none matches, attaching the resolved principal to the request
// context. Both use a constant-time compare (in principals.ts for the latter)
// and never log the token. /health and / + /ui are mounted outside these
// middlewares; the gateway gates /sessions/* with one of them (see
// buildAppWithRuntime). Mirrors src/openai/auth.ts.

import type { Context, MiddlewareHandler } from 'hono';
import { type Principal, resolvePrincipal } from './principals.js';

/** Hono per-request context variables for the native HTTP+SSE app. In
 *  principals mode the resolved {@link Principal} is stashed here by
 *  principalAuth so downstream routes can scope per-principal state (Phase
 *  E T4). Absent in legacy single-token / open modes. */
export type AppVariables = {
  principal?: Principal;
};

/** Typed accessor for the principal attached by {@link principalAuth}. Returns
 *  undefined in legacy single-token / open modes (no principal was resolved).
 *  Routes use this instead of a raw `c.get('principal')` so the type flows. */
export function getPrincipal(c: Context<{ Variables: AppVariables }>): Principal | undefined {
  return c.get('principal');
}

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

/**
 * Phase E — principal-aware bearer auth. Resolves the presented bearer token
 * against the principals registry; on no match returns 401 with the SAME JSON
 * error shape as {@link bearerAuth}. On match, attaches the resolved
 * {@link Principal} to the request context (`c.set('principal', p)`) for
 * downstream per-principal scoping, then continues.
 *
 * SECURITY: there is NO anonymous bypass — a missing or non-matching token is
 * always 401, even on loopback / in-process clients. The token itself is never
 * placed on the context (the resolver strips it). resolvePrincipal compares
 * each candidate token in constant time.
 */
export function principalAuth(
  principals: ReadonlyArray<{ id: string; token: string; name?: string | undefined }>,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    const presented = match?.[1] ?? '';
    const principal = presented ? resolvePrincipal(presented, principals) : null;
    if (principal === null) {
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
    c.set('principal', principal);
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
