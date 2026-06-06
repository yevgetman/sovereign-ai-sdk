// Phase E T1 — principals registry foundation: a pure token→principal resolver
// + the security-load-bearing id validator. A principal id becomes a filesystem
// path segment downstream (per-principal session/memory/learning isolation), so
// the validator must reject every traversal / separator / empty / control-char
// case — it is the path-segment guard, mirroring assertProfileName in paths.ts.

/** A resolved gateway principal — the public identity attached to a request
 *  once its bearer token has been matched. The token itself is never carried
 *  on this shape. */
export interface Principal {
  id: string;
  name?: string;
}

/** Safe-segment id: ASCII alphanumerics + `-` and `_`, one or more chars.
 *  `.` is intentionally NOT in the class, so `.`, `..`, `a.b`, `./x` all fail
 *  alongside separators (`/`), whitespace, and control chars (e.g. NUL). */
const PRINCIPAL_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Validate a principal id. SECURITY-LOAD-BEARING: this id is joined into a
 *  filesystem path downstream, so anything that isn't a well-formed safe
 *  segment must throw here. Empty strings, `.`/`..`, path separators,
 *  whitespace, and control characters are all rejected. */
export function validatePrincipalId(id: string): void {
  if (!PRINCIPAL_ID_RE.test(id)) {
    throw new Error(
      `invalid principal id ${JSON.stringify(id)}: must match ${PRINCIPAL_ID_RE} (ASCII alphanumerics, '-', '_', at least one char)`,
    );
  }
}

/** Resolve a presented bearer `token` to its principal, or `null` when no
 *  principal matches. Iterates ALL principals, comparing each candidate's
 *  token in constant time (mirrors src/server/auth.ts). Principal ordering is
 *  not secret, so breaking on the matched entry is fine — what matters is that
 *  every per-candidate compare is length-independent / constant-time, so the
 *  resolver never leaks which token (or how much of it) matched via timing. */
export function resolvePrincipal(
  token: string,
  principals: ReadonlyArray<{ id: string; token: string; name?: string }>,
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
