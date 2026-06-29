// Phase E T1 — the security-load-bearing principal-id validator. A principal id
// becomes a filesystem path segment downstream (per-principal session/memory/
// learning isolation), so the validator must reject every traversal / separator
// / empty / control-char case — it is the path-segment guard, mirroring
// assertProfileName in paths.ts.

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
