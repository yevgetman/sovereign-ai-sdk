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
// Backlog #37 + audit F17/F18/F19: the version may carry the SDK's own git
// short SHA as a pre-release suffix (e.g. `0.1.0-a89b03c`) — but ONLY when this
// module is genuinely running from the SDK's OWN source checkout. Two SHA
// sources, tried in order:
//
//   1. `.bun-tag` (preferred for source-mode global installs). When Bun
//      installs a package from a git source (`bun install -g git+ssh://…`) it
//      writes the resolved full SHA of the SDK ITSELF to
//      `<package-root>/.bun-tag`. Trusted unconditionally: it is a file the SDK
//      receives describing its OWN revision, not a directory walk.
//   2. `git rev-parse --short HEAD` — GATED. `spawnSync('git', …, { cwd })`
//      discovers a repo by walking UP the directory tree, so when the SDK is
//      installed as a dependency this walk escapes `node_modules` and resolves
//      the CONSUMER's `.git`, returning THEIR HEAD — which then leaks over the
//      wire to remote MCP servers (mcp/client) and onto disk (transcript/
//      writer). To make that impossible, the git resolver runs ONLY when BOTH:
//        (a) this module's directory is NOT under a `node_modules/` path
//            segment (an installed dependency always is); AND
//        (b) the discovered git worktree IS the SDK's OWN repo — its toplevel
//            either equals the package root (a standalone SDK checkout) or the
//            package root sits at the SDK's canonical `packages/sdk` path under
//            the toplevel (the harness monorepo dev layout, or a fork of it). A
//            consumer who VENDORS the SDK source into their OWN git repo (git
//            subtree / manual copy / a workspace package, NOT under
//            node_modules) is excluded: their copy lands at some OTHER relative
//            path, so a mere "packageRoot is somewhere inside this worktree" —
//            or "the toplevel's workspaces glob covers packageRoot" — test
//            would have leaked THEIR HEAD. Requiring the SDK's own canonical
//            layout closes that (audit C8: a broad `workspaces:["packages/*"]`
//            glob made the workspace-membership test too permissive).
//      If either fails — installed as a dep, or the enclosing repo is not the
//      SDK's own — the resolver short-circuits with NO subprocess and the bare
//      package.json version is reported. Net: an installed npm consumer AND a
//      vendored-source consumer both get a deterministic `0.1.0` (no git spawn,
//      no consumer SHA); a dev in the SDK's own checkout still gets the live
//      `0.1.0-<sdkSHA>`.
//
// In Bun-compiled binary mode both sources return null (`.bun-tag` won't exist;
// the git resolver is gated off — PKG_DIR sits in `/$bunfs/` with no package
// root and no enclosing worktree).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
 *  revision, so it is trusted without the git ownership gate below. */
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

/** True when `dir` contains a `node_modules` path segment — i.e. the module is
 *  running as an installed dependency, where a git walk would escape into the
 *  CONSUMER's repo. */
function isUnderNodeModules(dir: string): boolean {
  return dir.split(sep).includes('node_modules');
}

/** The SDK's canonical position under its own monorepo git root. The SHA gate
 *  emits a suffix only from this exact layout (or a standalone SDK checkout),
 *  never from an arbitrary path a consumer happens to vendor the source into. */
const SDK_OWN_RELATIVE_PATH = join('packages', 'sdk');

/** True when the git worktree rooted at `toplevel` is the SDK's OWN repo. Two
 *  own-checkout shapes qualify:
 *    - the toplevel IS the package root (a standalone SDK checkout); OR
 *    - the package root sits at the SDK's canonical `packages/sdk` path under
 *      the toplevel (the harness monorepo dev layout, or any fork of it).
 *
 *  This is tightened from the earlier "toplevel declares packageRoot as a
 *  workspace member" test, which any consumer monorepo with a broad
 *  `workspaces: ["packages/*"]` glob ALSO satisfied when it vendored the SDK as
 *  a workspace package — leaking the consumer's private HEAD (audit C8). A
 *  vendored/workspace-member copy lands at some OTHER relative path (e.g.
 *  `packages/sov-sdk`, `vendor/sdk`), so its relative path differs and the gate
 *  stays closed. (F17-19 sibling.) */
function gitToplevelOwnsSdk(toplevel: string, packageRoot: string): boolean {
  const top = resolve(toplevel);
  const pkg = resolve(packageRoot);
  if (top === pkg) return true;
  return relative(top, pkg) === SDK_OWN_RELATIVE_PATH;
}

/** `git -C dir rev-parse --show-toplevel` → the enclosing worktree root, or
 *  null when `dir` is not inside a git repo (or git is unavailable). */
function gitToplevel(dir: string): string | null {
  try {
    const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    const top = result.stdout.trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/** `git rev-parse --short HEAD` with cwd=`dir`, or null. */
function gitShortHead(dir: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir,
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

/**
 * Resolve the pre-release SHA suffix for VERSION, gated so it can NEVER read a
 * consumer's git repo (audit F17/F18/F19).
 *
 * Order: the SDK's own `.bun-tag` (always trusted) → a git short SHA, but the
 * git spawn happens ONLY from the SDK's own source checkout — `pkgDir` not
 * under `node_modules` AND the enclosing git worktree IS the SDK's own repo
 * (its toplevel equals `packageRoot`, or `packageRoot` sits at the SDK's
 * canonical `packages/sdk` path under the toplevel). A vendored source copy
 * inside a consumer repo — even one made a workspace member by a broad
 * `workspaces` glob — lands at a different relative path, fails the ownership
 * test, and returns null (bare base version) with NO git subprocess.
 *
 * Exported for testability: pass a scratch `pkgDir`/`packageRoot` to exercise
 * the gate without relocating the module. The module-level VERSION export below
 * calls it with the real PKG_DIR / resolved package root.
 */
export function resolveShaSuffix(pkgDir: string, packageRoot: string | null): string | null {
  const bunTagSha = resolveBunTagSha(packageRoot);
  if (bunTagSha !== null) return bunTagSha;

  // Ownership gate: only ever read a git SHA from the SDK's OWN checkout — the
  // discovered worktree must BE the SDK's repo (toplevel === packageRoot, or
  // packageRoot at the canonical `packages/sdk` path under the toplevel). A
  // consumer that vendors the source into their own repo (even as a workspace
  // member) fails this and never leaks their SHA.
  if (packageRoot === null) return null;
  if (isUnderNodeModules(pkgDir)) return null;
  const toplevel = gitToplevel(pkgDir);
  if (toplevel === null || !gitToplevelOwnsSdk(toplevel, packageRoot)) return null;

  return gitShortHead(pkgDir);
}

/** Assemble the version string from the base and an optional SHA suffix. */
export function composeVersion(baseVersion: string, sha: string | null): string {
  return sha === null ? baseVersion : `${baseVersion}-${sha}`;
}

const RESOLVED_PKG_ROOT = findPackageRoot(PKG_DIR);
const baseVersion: string = readBaseVersion(RESOLVED_PKG_ROOT);
const resolvedSha = resolveShaSuffix(PKG_DIR, RESOLVED_PKG_ROOT);

export const VERSION: string = composeVersion(baseVersion, resolvedSha);
