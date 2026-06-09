// Shared path-containment predicates for the plugin subsystem (T9 cleanup).
//
// CONTRACT: these are the **non-realpath** containment checks — they resolve `..`
// and `.` segments via `path.resolve` but do NOT follow symlinks. They answer the
// purely lexical question "does the resolved candidate sit under the resolved
// root?". The trailing-separator guard on the prefix avoids the classic
// `/foo` vs `/foobar` sibling-prefix false positive.
//
// This is the load-bearing boundary the loader's liveness probe, the compose
// skill/command-dir override check, and the install manifest-path gate all share
// (previously three byte-identical `isWithin`/`isContainedUnder` copies). Keeping
// it in one place means the security boundary cannot drift between surfaces.
//
// For SYMLINK-RESOLVING containment (a copy path that must reject out-of-tree
// links) use `assertNoSymlinkEscape` / the realpath-based `isContainedUnder` in
// `src/skills/symlinkGuard.ts` — that is a DIFFERENT, stronger contract and is
// intentionally NOT consolidated here.

import { dirname, resolve, sep } from 'node:path';

/**
 * True when `candidate` resolves to a path at or under `root`. Both inputs are
 * resolved (so `..`/`.` are normalized); the trailing-separator on the prefix
 * avoids the `/foo` vs `/foobar` sibling-prefix bug. Lexical only — does NOT
 * resolve symlinks (use `symlinkGuard` for that contract).
 */
export function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  return resolvedCandidate.startsWith(resolvedRoot + sep);
}

/**
 * True when `candidate` is contained under `root` AND exactly one level deep
 * (its parent IS the root). The plugin-uninstall containment guard: a removal
 * target must be a direct child of the plugins root, never the root itself nor
 * something nested deeper. Lexical only — like `isWithin`, does NOT resolve
 * symlinks.
 */
export function isOneLevelUnder(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isWithin(resolvedRoot, resolvedCandidate) || resolvedCandidate === resolvedRoot) {
    return false;
  }
  return dirname(resolvedCandidate) === resolvedRoot;
}
