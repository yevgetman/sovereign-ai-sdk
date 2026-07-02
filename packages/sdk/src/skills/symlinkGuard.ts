// Symlink containment guard for copied skill trees — the SHARED copy path used
// by both installSkill and importSkill.
//
// `cp(src, dst, { recursive: true })` preserves symlinks verbatim. A malicious
// skill package could therefore ship e.g. `references/x -> ~/.ssh/id_rsa`, which
// would land inside `<harnessHome>/skills/<name>/` on install/import; a
// guard-clean SKILL.md body could then instruct the model to read it. We reject
// any symlink in the source tree whose resolved real path escapes the source
// root BEFORE copying — a legitimate skill needing out-of-tree symlinks is not a
// real use case, so failing loud is the safest contract. This hardens both the
// new importSkill and the pre-existing installSkill in one place.

import { cp, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/** Thrown when a source skill tree contains a symlink that resolves outside the
 *  source root. Carries the offending link + its resolved target for a clear,
 *  actionable error message. */
export class SymlinkEscapeError extends Error {
  constructor(
    readonly linkPath: string,
    readonly resolvedTarget: string,
  ) {
    super(
      `refusing to copy skill: symlink '${linkPath}' resolves to '${resolvedTarget}', which is outside the skill source directory`,
    );
    this.name = 'SymlinkEscapeError';
  }
}

/** True when `childReal` is the same as, or nested under, `rootReal`. Both must
 *  already be realpath-resolved so `..` segments and intermediate symlinks
 *  cannot smuggle the path out of the root. */
function isContainedUnder(rootReal: string, childReal: string): boolean {
  if (childReal === rootReal) return true;
  const rel = relative(rootReal, childReal);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

/**
 * Recursively scan `sourceAbs` and throw `SymlinkEscapeError` if any symlink
 * (at any depth) resolves to a real path outside `sourceAbs`, or is dangling
 * (unprovable containment). In-tree symlinks are allowed.
 *
 * Exposed for direct testing; `copySkillTree` calls it before copying.
 */
export async function assertNoSymlinkEscape(sourceAbs: string): Promise<void> {
  const rootReal = await realpath(resolve(sourceAbs));
  await scan(resolve(sourceAbs), rootReal);
}

async function scan(dir: string, rootReal: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await assertLinkContained(entryPath, rootReal);
      continue;
    }
    if (entry.isDirectory()) {
      await scan(entryPath, rootReal);
    }
  }
}

async function assertLinkContained(linkPath: string, rootReal: string): Promise<void> {
  let targetReal: string;
  try {
    // realpath fully resolves the link chain (and any nested links along it).
    targetReal = await realpath(linkPath);
  } catch {
    // A dangling/broken symlink resolves to nothing reachable. We cannot prove
    // it stays in-tree, and copying a dangling link into the skills root has no
    // legitimate use — treat it as an escape.
    throw new SymlinkEscapeError(linkPath, '(unresolvable / dangling symlink)');
  }
  if (!isContainedUnder(rootReal, targetReal)) {
    throw new SymlinkEscapeError(linkPath, targetReal);
  }
}

/**
 * Symlink-safe recursive copy of a skill source tree. Rejects out-of-tree
 * symlinks (via `assertNoSymlinkEscape`) BEFORE copying so a hostile package is
 * refused before anything lands on disk, then performs the normal recursive
 * copy. The single shared entry point for both installSkill and importSkill.
 */
export async function copySkillTree(sourceAbs: string, targetDir: string): Promise<void> {
  await assertNoSymlinkEscape(sourceAbs);
  await cp(sourceAbs, targetDir, { recursive: true });
}
