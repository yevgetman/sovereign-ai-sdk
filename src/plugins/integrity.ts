// Plugin tree-hash integrity (T2). `hashPluginTree` is the load-bearing
// tamper-evidence primitive (S1): a deterministic SHA-256 content hash over
// EVERY file in a plugin tree EXCEPT the consent record itself. The T3 loader
// compares it against the hash stored at consent (`verifyConsent` in
// consent.ts) to detect a tree edited after consent — the TOCTOU case where a
// plugin is consented and then its files are swapped (H4 / C1).
//
// Determinism contract:
//  - The file list is gathered by a full recursive walk, then sorted by
//    relative POSIX path BEFORE hashing — so the result is independent of the
//    OS directory-walk order.
//  - For each file (in sorted order) we fold in the relative path + a NUL
//    separator + the file bytes, so both *what* changed and *where* it lives
//    flip the hash. A NUL separator (impossible in a path) keeps path/content
//    boundaries unambiguous (no "ab"+"c" vs "a"+"bc" collision).
//  - `.consent.json` is skipped so writing the record does not invalidate the
//    hash it records. Nothing else is skipped.
//
// Pure: this module reads the filesystem but writes nothing and mutates no input.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The consent record filename — excluded from the tree hash so writing it does
 *  not invalidate the hash it stores. Also the file consent.ts reads/writes. */
export const CONSENT_FILENAME = '.consent.json';

/** Field/record separator folded between a file's relative path and its bytes.
 *  A NUL byte cannot appear in a path, so path/content boundaries are
 *  unambiguous and no concatenation collision is possible. */
const SEPARATOR = Buffer.from([0]);

/** Deterministic SHA-256 content hash over every file under `dir` (recursing
 *  into subdirectories) EXCEPT `.consent.json`. Same tree → same hash; any
 *  file content change, addition, or removal → a different hash; independent
 *  of directory-walk order. Returns a lowercase hex digest. */
export function hashPluginTree(dir: string): string {
  const files = collectFiles(dir);
  // Normalize ordering so the hash does not depend on readdir order. Relative
  // POSIX paths give a stable, platform-independent sort key.
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relPath, 'utf8');
    hash.update(SEPARATOR);
    hash.update(readFileSync(file.absPath));
    hash.update(SEPARATOR);
  }
  return hash.digest('hex');
}

type TreeFile = { relPath: string; absPath: string };

/** Recursively gather every file under `root` (excluding `.consent.json`),
 *  each tagged with its forward-slash-normalized relative path. */
function collectFiles(root: string): TreeFile[] {
  const files: TreeFile[] = [];
  walk(root, root, files);
  return files;
}

function walk(current: string, root: string, out: TreeFile[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absPath = join(current, entry.name);
    if (entry.isDirectory()) {
      walk(absPath, root, out);
      continue;
    }
    // Skip the consent record itself; hash everything else.
    if (entry.name === CONSENT_FILENAME) continue;
    out.push({ relPath: toPosix(relative(root, absPath)), absPath });
  }
}

/** Normalize a relative path to forward slashes so the sort key + hashed path
 *  are identical regardless of platform separator. */
function toPosix(relPath: string): string {
  return sep === '/' ? relPath : relPath.split(sep).join('/');
}
