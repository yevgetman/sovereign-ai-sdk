// Phase 10.8 — default bundle resolver. Two-step fallthrough:
//
//   1. <harness-home>/default-bundle/  — user override location
//   2. <runtime-repo>/bundle-default/  — shipped default
//
// The shipped path is resolved via `realpathSync` of the entry script,
// the same trick `loadPackageEnv()` uses in `src/main.ts`. This means
// the bundle is found whether `sov` is run from a clone, a `bun link`
// install, or a `bun install -g` install — the resolver always lands
// on the bundle that lives next to the running source.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHarnessHome } from '../config/paths.js';

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

/** `<runtime-repo>/bundle-default/`. Returns null when import.meta.url
 *  isn't a file URL (rare; would mean running outside Bun's module
 *  loader). */
export function shippedBundlePath(): string | null {
  try {
    const realMain = realpathSync(fileURLToPath(import.meta.url));
    // src/bundle/defaultBundle.ts → walk up two levels to the repo root
    return join(dirname(dirname(dirname(realMain))), 'bundle-default');
  } catch {
    return null;
  }
}
