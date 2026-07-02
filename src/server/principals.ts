// Phase E T1 — principals registry foundation: a pure token→principal resolver.
// The security-load-bearing id validator now lives in src/util/principals.ts
// (open-core relocation); it is re-exported here so proprietary importers keep
// working unchanged.

export { validatePrincipalId } from '@yevgetman/sov-sdk/util/principals';

/** A resolved gateway principal — the public identity attached to a request
 *  once its bearer token has been matched. The token itself is never carried
 *  on this shape. */
export interface Principal {
  id: string;
  name?: string;
}

/** Resolve a presented bearer `token` to its principal, or `null` when no
 *  principal matches. Iterates ALL principals, comparing each candidate's
 *  token in constant time (mirrors src/server/auth.ts). Principal ordering is
 *  not secret, so breaking on the matched entry is fine — what matters is that
 *  every per-candidate compare is length-independent / constant-time, so the
 *  resolver never leaks which token (or how much of it) matched via timing. */
export function resolvePrincipal(
  token: string,
  principals: ReadonlyArray<{ id: string; token: string; name?: string | undefined }>,
): Principal | null {
  let matched: { id: string; name?: string } | null = null;
  for (const p of principals) {
    if (timingSafeEqual(token, p.token)) {
      matched = { id: p.id, ...(p.name !== undefined ? { name: p.name } : {}) };
      break;
    }
  }
  return matched;
}

/** Constant-time string compare. Mirrors src/server/auth.ts. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
