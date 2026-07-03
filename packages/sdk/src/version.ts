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
// SHA suffix — DETERMINISTIC, NO RUNTIME GIT (audit E2/E4, backlog #37):
// the version may carry the SDK's own git short SHA as a pre-release suffix
// (e.g. `0.1.0-a89b03c`) from EXACTLY ONE source — the SDK's OWN `.bun-tag`
// file. When Bun installs a package from a git source (`bun install -g
// git+ssh://…`) it writes the resolved full SHA of the SDK ITSELF to
// `<package-root>/.bun-tag`; that file is the SDK describing its OWN revision,
// so it is unambiguous and trusted without any repo walk.
//
// Everything else reports the bare package.json version (`0.1.0`) with NO git
// subprocess and NO SHA suffix. Earlier revisions ALSO ran a `git` subprocess to
// resolve the short HEAD and tried to prove, via path heuristics, that the
// enclosing git worktree was the SDK's own — but every heuristic
// (not-under-node_modules, toplevel-equals-packageRoot, workspace-member,
// canonical `packages/sdk` path) was spoofable by a common consumer layout,
// leaking the CONSUMER's private HEAD over the wire (mcp/client) and onto disk
// (transcript/writer). The class is now closed BY ELIMINATION: this module no
// longer imports a subprocess API at all, so no layout —
// npm install, source vendoring at any path (INCLUDING the canonical
// `packages/sdk`), a workspace member, or a dev checkout — can emit a foreign
// SHA, because there is no repo to resolve. The only cost is that a dev working
// in the SDK's own checkout no longer gets a live `-<sha>` suffix; that is the
// accepted trade (and was the original recommendation). A release build that
// WANTS an embedded SHA can inject it at build time (e.g. `bun build --define`)
// without reintroducing any runtime git.
//
// In Bun-compiled binary mode `.bun-tag` won't exist (PKG_DIR sits in `/$bunfs/`
// with no package root) → no suffix, the bare FALLBACK_VERSION.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHORT_SHA_LENGTH = 7;
const MAX_PACKAGE_JSON_WALK_DEPTH = 5;
const FALLBACK_VERSION = '0.0.0';
const PKG_DIR = dirname(fileURLToPath(import.meta.url));

/** Walk up from `startDir` to the nearest package.json dir.
 *  src/ and dist/ both sit one level below the package root, so the walk
 *  terminates on the first step in every supported layout; the bounded loop
 *  keeps it correct if the module ever moves deeper. Returns null when no
 *  package.json is reachable (Bun-compiled `/$bunfs/` mode). */
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
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

/** Read the SDK's OWN resolved SHA from `<packageRoot>/.bun-tag` (written by
 *  `bun install` from a git source). This is the SDK describing its own
 *  revision — the ONE unambiguous SHA source, needing no repo walk and no
 *  ownership heuristic — so it is trusted unconditionally. */
function resolveBunTagSha(packageRoot: string | null): string | null {
  if (packageRoot === null) return null;
  try {
    const bunTagPath = join(packageRoot, '.bun-tag');
    if (!existsSync(bunTagPath)) return null;
    const raw = readFileSync(bunTagPath, 'utf-8').trim();
    if (!/^[a-f0-9]{40}$/.test(raw)) return null;
    return raw.slice(0, SHORT_SHA_LENGTH);
  } catch {
    return null;
  }
}

/**
 * Resolve the pre-release SHA suffix for VERSION. Deterministic and git-free:
 * the ONLY source is the SDK's own `<packageRoot>/.bun-tag`. No git subprocess
 * ever runs, so NO consumer layout — npm install, vendored source at ANY path
 * (including the canonical `packages/sdk`), a workspace member, or a dev
 * checkout — can leak a foreign HEAD (audit E2/E4). Returns null (bare base
 * version) whenever no trusted `.bun-tag` is present.
 *
 * Exported for testability: pass a scratch `packageRoot` to exercise the
 * `.bun-tag` path. The module-level VERSION export below calls it with the real
 * resolved package root.
 */
export function resolveShaSuffix(packageRoot: string | null): string | null {
  return resolveBunTagSha(packageRoot);
}

/** Assemble the version string from the base and an optional SHA suffix. */
export function composeVersion(baseVersion: string, sha: string | null): string {
  return sha === null ? baseVersion : `${baseVersion}-${sha}`;
}

const RESOLVED_PKG_ROOT = findPackageRoot(PKG_DIR);
const baseVersion: string = readBaseVersion(RESOLVED_PKG_ROOT);
const resolvedSha = resolveShaSuffix(RESOLVED_PKG_ROOT);

export const VERSION: string = composeVersion(baseVersion, resolvedSha);
