// Single source of truth for the SDK package version (`@yevgetman/sov-sdk`),
// consumed by open surfaces that print a build identifier (transcript/writer,
// mcp/client). The WRAPPER's version lives in the root src/wrapperVersion.ts
// (the harness 0.6.x line) — this module reports the SDK's own 0.1.x line.
//
// Phase 3 (the package move): the previous `import pkg from '../package.json'`
// JSON import cannot survive the packaged build — under tsconfig.build.json
// (rootDir: src) the package.json sits OUTSIDE rootDir, so tsc refuses to emit
// it. Instead the manifest is read AT RUNTIME by walking up from this module's
// directory to the nearest package.json. That resolves identically from
//   packages/sdk/src/version.ts  (dev / bun source mode)   → ../package.json
//   packages/sdk/dist/version.js (published Node consumers) → ../package.json
// and is depth-robust should the file ever nest deeper. In Bun-compiled binary
// mode (`bun build --compile`) the walk fails inside the `/$bunfs/` virtual
// filesystem (nothing embeds a computed-path package.json) → FALLBACK_VERSION;
// the compiled binary's user-facing `--version` comes from wrapperVersion.ts,
// which keeps its build-time JSON import precisely for that mode.
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
// because PKG_DIR points into /$bunfs/).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHORT_SHA_LENGTH = 7;
const MAX_PACKAGE_JSON_WALK_DEPTH = 5;
const FALLBACK_VERSION = '0.0.0';
const PKG_DIR = dirname(fileURLToPath(import.meta.url));

/** Walk up from this module's directory to the nearest package.json dir.
 *  src/ and dist/ both sit one level below the package root, so the walk
 *  terminates on the first step in every supported layout; the bounded loop
 *  keeps it correct if the module ever moves deeper. Returns null when no
 *  package.json is reachable (Bun-compiled `/$bunfs/` mode). */
function findPackageRoot(): string | null {
  let dir = PKG_DIR;
  for (let depth = 0; depth < MAX_PACKAGE_JSON_WALK_DEPTH; depth += 1) {
    try {
      if (existsSync(join(dir, 'package.json'))) return dir;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readBaseVersion(root: string | null): string {
  if (root === null) return FALLBACK_VERSION;
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

const RESOLVED_PKG_ROOT = findPackageRoot();
const PKG_ROOT = RESOLVED_PKG_ROOT ?? join(PKG_DIR, '..');
const BUN_TAG_PATH = join(PKG_ROOT, '.bun-tag');

const baseVersion: string = readBaseVersion(RESOLVED_PKG_ROOT);

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
