// Wrapper-owned version source — Task 3.1 of the SDK consumable-packaging
// build. The proprietary wrapper surfaces (sov --version via main.ts, the
// CLI launchers' --harness-version forwarding, the gateway + OpenAI-server
// /health routes) report the HARNESS release line (0.6.x) read from the
// ROOT package.json relative to this file.
//
// Why this exists separately from src/version.ts: version.ts is OPEN
// (openRootFiles in scripts/boundary-manifest.json) and moves into
// packages/sdk/src/ in Phase 3 — after the move its `../package.json`
// import resolves to the SDK package's OWN manifest (0.1.x line). That is
// correct for the SDK's open consumers (transcript/writer, mcp/client) but
// would silently flip the wrapper's displayed version onto the SDK line.
// This module stays behind in src/ and is NON-open by the manifest
// (openRootFiles lists only version.* and sdk.*).
//
// The SHA-suffix logic below is an intentional small duplication of
// version.ts (backlog #37 semantics: `<base>-<shortsha>` dev-build suffix
// via .bun-tag then `git rev-parse`, bare semver in Bun-compiled binary
// mode where both resolvers return null). version.ts exports only VERSION —
// reusing its internals would mean widening the frozen open surface and,
// post-move, importing a trivial leaf across the package boundary. The two
// files legitimately diverge after the move (different package roots,
// different .bun-tag locations).

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
