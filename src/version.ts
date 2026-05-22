// Single source of truth for the package version. Imports the version
// directly from package.json via a build-time JSON import so /health,
// --version, and any other surface that prints a build identifier all
// agree with the manifest the package was installed (or compiled) under.
//
// Phase 21: the JSON import works in both source mode (`bun src/main.ts`)
// AND Bun-compiled binary mode (`bun build --compile`). The previous
// runtime-read approach (readFileSync(PKG_PATH)) broke in compiled mode
// because process.execPath-relative paths don't resolve into the
// embedded `/$bunfs/` virtual filesystem.
//
// Backlog #37: also resolves the git short SHA at module load and
// appends it as a pre-release suffix (e.g. `0.1.0-a89b03c`). Two
// resolvers, tried in order, covering both deployment modes:
//
//   1. `.bun-tag` (preferred for source-mode global installs). When Bun
//      installs a package from a git source (`bun install -g
//      git+ssh://…`), it writes the resolved full SHA to
//      `<install-root>/.bun-tag` and does NOT ship a `.git/` directory.
//   2. `git rev-parse --short HEAD` (fallback for dev `bun link` or
//      local working-tree runs).
//
// In Bun-compiled binary mode both resolvers gracefully return null
// (`.bun-tag` won't exist next to the binary; `git rev-parse` fails
// because PKG_DIR points into /$bunfs/). The compiled binary's
// `--version` prints the bare release tag (e.g. `0.2.0`) which matches
// the GitHub Release.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const SHORT_SHA_LENGTH = 7;
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(PKG_DIR, '..');
const BUN_TAG_PATH = join(PKG_ROOT, '.bun-tag');

const baseVersion: string = (pkg as { version: string }).version;

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
