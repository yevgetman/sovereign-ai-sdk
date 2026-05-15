// Single source of truth for the package version. Reads from package.json
// at module load so /health, --version, and any other surface that prints
// a build identifier all agree with the manifest the package was installed
// under. Previously these were hardcoded literals that drifted (health
// reported '0.0.1' while package.json said '0.1.0').
//
// Backlog #37: also resolves the git short SHA at module load and appends
// it as a pre-release suffix (e.g. `0.1.0-a89b03c`). Two resolvers, tried
// in order, covering both deployment modes:
//
//   1. `.bun-tag` (preferred for global installs). When Bun installs a
//      package from a git source (`bun install -g git+ssh://…`), it writes
//      the resolved full SHA to `<install-root>/.bun-tag` and does NOT
//      ship a `.git/` directory. This is the canonical Bun-managed answer
//      for post-`sov upgrade` global installs and matches what `bun pm
//      ls -g` reports.
//   2. `git rev-parse --short HEAD` (fallback for dev `bun link` or local
//      working-tree runs). The repo root one level above `src/` IS a git
//      checkout in this mode, so the rev-parse succeeds.
//
// Falls back to bare semver if neither resolver returns a SHA (the dev
// tree isn't a git checkout AND `.bun-tag` is missing — e.g., a tarball
// install). The existing `--version` contract never regresses on failure.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHORT_SHA_LENGTH = 7;
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(PKG_DIR, '..');
const PKG_PATH = join(PKG_ROOT, 'package.json');
const BUN_TAG_PATH = join(PKG_ROOT, '.bun-tag');

const baseVersion: string = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string })
  .version;

function resolveBunTagSha(): string | null {
  try {
    if (!existsSync(BUN_TAG_PATH)) return null;
    const raw = readFileSync(BUN_TAG_PATH, 'utf-8').trim();
    if (!/^[a-f0-9]{40}$/.test(raw)) return null;
    return raw.slice(0, SHORT_SHA_LENGTH);
  } catch {
    return null;
  }
}

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

const resolvedSha = resolveBunTagSha() ?? resolveGitSha();

export const VERSION: string = resolvedSha === null ? baseVersion : `${baseVersion}-${resolvedSha}`;
