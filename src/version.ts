// Single source of truth for the package version. Reads from package.json
// at module load so /health, --version, and any other surface that prints
// a build identifier all agree with the manifest the package was installed
// under. Previously these were hardcoded literals that drifted (health
// reported '0.0.1' while package.json said '0.1.0').
//
// Backlog #37: also resolves the git short SHA at module load and appends
// it as a pre-release suffix (e.g. `0.1.0-28b43e6`). Works for both
// deployment modes — `bun link` (this working tree IS the git checkout)
// and `bun install -g git+ssh://…` (Bun's cache at
// ~/.bun/install/global/node_modules/@yevgetman/sov/ is also a git checkout
// post-`sov upgrade`). Falls back to bare semver if git is absent, the
// checkout isn't a git repo, the command fails, or stdout is empty — so
// the existing `--version` contract never regresses.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(PKG_DIR, '../package.json');

const baseVersion: string = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string })
  .version;

function resolveGitSha(): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: PKG_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

const gitSha = resolveGitSha();

export const VERSION: string = gitSha === null ? baseVersion : `${baseVersion}-${gitSha}`;
