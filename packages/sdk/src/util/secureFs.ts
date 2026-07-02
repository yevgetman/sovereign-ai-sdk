// Restrictive-permission helpers for on-disk SDK state artifacts (audit
// F10/F16). Session transcripts, traces, trajectories, the shell-hook consent
// allowlist, the credentials pool/rate state, and the HARNESS_HOME state root
// all hold conversation content, tool I/O, or operator decisions that must not
// be world-readable on a shared / multi-tenant / CI host. Directories are
// created 0700 (owner-only traversal); files are 0600 (owner-only read/write).
//
// Why chmod in addition to a create-time `mode:`? A create `mode` is masked by
// the process umask AND is only applied when the inode is first created — it
// does NOT tighten a dir/file left 0755/0644 by an older version. `chmodSafe`
// re-tightens defensively. It is intentionally best-effort: chmod is a near
// no-op on Windows (which only models the read-only bit) and can fail for a
// non-owner, so a tightening failure NEVER turns a best-effort write into a
// crash — the writers here are all documented as non-blocking (Invariant #10).

import { chmodSync, mkdirSync } from 'node:fs';

/** 0700 — owner rwx only. Denies traversal/listing by other local uids. */
export const SECURE_DIR_MODE = 0o700;

/** 0600 — owner rw only. Denies read by other local uids. */
export const SECURE_FILE_MODE = 0o600;

/** Best-effort chmod. Never throws (Windows no-op / non-owner / race with an
 *  unlink). Use for permission-tightening that must not break a best-effort
 *  write path. */
export function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort: a failure to tighten perms must not break the write.
  }
}

/** Recursively create `dir` with restrictive 0700 perms, then defensively
 *  re-tighten it (the recursive `mode` is umask-masked and is not applied to a
 *  dir an older version already left 0755). Owner bits survive the default 022
 *  umask (0o700 & ~022 === 0o700). */
export function secureMkdir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
  chmodSafe(dir, SECURE_DIR_MODE);
}
