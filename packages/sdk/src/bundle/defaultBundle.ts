// Phase 10.8 — default bundle resolver. Two-step fallthrough:
//
//   1. <harness-home>/default-bundle/  — user override location
//   2. <runtime-repo>/bundle-default/  — shipped default
//
// Phase 21 — binary-install mode resolves the shipped bundle via
// process.execPath FIRST (the Bun-compiled binary lives at
// e.g. ~/.sov/bin/sov; the bundle ships as a sibling
// ~/.sov/bundle-default/). When that check misses, falls through to the
// source-mode resolver (import.meta.url walk to the repo root). Source-
// mode behavior is preserved bit-for-bit because the binary-mode check
// fails by design for every source-mode invocation (process.execPath is
// the bun runtime itself, with no bundle-default sibling).
//
// Phase 13.3 (B2) — adds isDefaultBundlePath() predicate for routing
// trajectory writes away from the stock bundle's tree.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHarnessHome } from '../config/paths.js';

const MAX_SOURCE_BUNDLE_WALK_DEPTH = 16;

/** Resolve the default bundle path. Returns null only when neither the
 *  override nor the shipped bundle exists — which should be impossible
 *  in a healthy install (the shipped bundle is committed to the repo)
 *  but we still treat the absence as a soft failure rather than a hard
 *  crash. The caller falls back to bundleless behavior in that case. */
export function getDefaultBundlePath(): string | null {
  const override = userOverridePath();
  if (existsSync(join(override, 'index.yaml'))) return override;
  const shipped = shippedBundlePath();
  if (shipped !== null && existsSync(join(shipped, 'index.yaml'))) return shipped;
  return null;
}

/** `<harness-home>/default-bundle/`. Resolved at call time so the
 *  Phase 10.7 profile system (which scopes harness-home) lands the
 *  override under the right root. */
export function userOverridePath(): string {
  return join(resolveHarnessHome(), 'default-bundle');
}

/** `<runtime-repo>/bundle-default/` (source mode) OR
 *  `<dirname(execPath)/../bundle-default/` (binary install mode).
 *
 *  Binary mode is tried first. The check is content-based (existsSync
 *  on index.yaml) so it works for any install layout, not just ~/.sov/.
 *
 *  Returns null only when BOTH resolvers fail (rare; would mean a
 *  broken install with no bundle-default anywhere reachable).
 *
 *  The optional overrides are test seams: production passes nothing. */
export function shippedBundlePath(
  opts: { execPath?: string; metaUrl?: string } = {},
): string | null {
  // Binary install mode: process.execPath points to the on-disk
  // compiled binary (e.g. ~/.sov/bin/sov). Look for a sibling
  // bundle-default/ at <dirname(dirname(execPath))>/bundle-default.
  try {
    const execPath = opts.execPath ?? process.execPath;
    const execDir = dirname(realpathSync(execPath));
    const candidate = join(dirname(execDir), 'bundle-default');
    if (existsSync(join(candidate, 'index.yaml'))) return candidate;
  } catch {
    // realpath threw (missing file, permission, etc.) — fall through.
  }

  // Source mode: walk up from this file's URL until a committed
  // bundle-default/ is found. This covers the live workspace and copied
  // file: package installs under node_modules/.bun/.
  // For `bun src/main.ts` or `bun install -g` installs, the binary
  // branch above misses by design (process.execPath is the bun
  // executable itself, with no bundle-default sibling) so we land here.
  try {
    const metaUrl = opts.metaUrl ?? import.meta.url;
    const realMain = realpathSync(fileURLToPath(metaUrl));
    return findBundleDefaultFrom(realMain);
  } catch {
    return null;
  }
}

function findBundleDefaultFrom(path: string): string | null {
  let dir = dirname(path);
  for (let depth = 0; depth < MAX_SOURCE_BUNDLE_WALK_DEPTH; depth += 1) {
    const candidate = join(dir, 'bundle-default');
    if (existsSync(join(candidate, 'index.yaml'))) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Returns true when bundleRoot resolves to the same real path as the
 *  stock default bundle (user-override or shipped). Used by the runtime
 *  to route trajectories to <harnessHome>/ instead of
 *  <bundle>/state/artifacts/ — the default bundle is system content, not
 *  per-user state, so trajectory writes should not land inside it (they
 *  would be wiped by `sov upgrade` and not be profile-scoped).
 *
 *  Compared via realpathSync so symlinked installs (bun install -g caches
 *  packages under a content-addressed tree) resolve correctly.
 *
 *  Phase 13.3 (B2). */
export function isDefaultBundlePath(bundleRoot: string): boolean {
  const def = getDefaultBundlePath();
  if (def === null) return false;
  try {
    return realpathSync(bundleRoot) === realpathSync(def);
  } catch {
    // realpath failures (broken symlinks, missing paths) — fall back to
    // strict string compare so the predicate never throws.
    return bundleRoot === def;
  }
}
