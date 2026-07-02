// Shared filesystem locations. Phase 10.7 introduces a profile system:
// `harness -p work chat …` and `harness -p personal chat …` get separate
// config, credentials, sessions, memory, skills, traces, trajectories, and
// daemon locks. Profiles live under `<base>/profiles/<name>/`; without -p
// the runtime falls back to `<base>/` itself (the default profile).
//
// `HARNESS_HOME` is the env knob — set it to point the entire runtime at
// a different state root. `src/main.ts` parses `-p/--profile` before any
// other import and sets HARNESS_HOME accordingly so every getHarnessHome()
// call site automatically lands in the right place. Per Invariant #11
// (profile = env var before imports).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SECURE_DIR_MODE } from '../util/secureFs.js';

/** Reserved profile name used to point at the unscoped default state
 *  root (i.e., `<base>/` itself). The `default` name maps to the same
 *  location as having no profile at all. */
export const DEFAULT_PROFILE_NAME = 'default';

/** File at `<base>/active-profile` storing the persisted profile name.
 *  `sov profile use <name>` writes it; `sov` reads it on startup unless
 *  `-p` overrides. */
const ACTIVE_PROFILE_FILENAME = 'active-profile';

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Resolve the harness state root. When `HARNESS_HOME` is set, it's used
 *  verbatim (after path resolution); otherwise we default to `~/.harness`.
 *  The directory is created on read since multiple call sites assume it
 *  exists for subsequent file IO. Cheap idempotent mkdir — Bun does a
 *  single stat. */
export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const root = resolve(env.HARNESS_HOME ?? join(homedir(), '.harness'));
  // The state root holds conversation/state artifacts — create it 0700 so other
  // local uids cannot traverse into it (audit F10). A create-time `mode` (not an
  // unconditional chmod) is used deliberately: this is a hot path called all
  // over the runtime, and force-chmod'ing the shared root on every call would be
  // wasteful and would override an operator's deliberate perms on an existing
  // root. Owner bits survive the default 022 umask (0o700 & ~022 === 0o700).
  mkdirSync(root, { recursive: true, mode: SECURE_DIR_MODE });
  return root;
}

/** Alias used in newer call sites; identical to `resolveHarnessHome()`.
 *  The build plan calls this `getHarnessHome()` per Invariant #11. */
export const getHarnessHome = resolveHarnessHome;

/** The base — the unscoped state root, ignoring any profile selection
 *  the env or argv may have applied. Used by `sov profile` subcommands
 *  that operate on the global profile registry rather than the active
 *  profile. */
export function getBaseHome(): string {
  // When no profile has been activated, HARNESS_HOME equals the base.
  // When a profile is active, HARNESS_HOME points at <base>/profiles/<name>;
  // we walk back up to the base by stripping that suffix.
  const home = resolveHarnessHome();
  const marker = `${sep}profiles${sep}`;
  const idx = home.indexOf(marker);
  if (idx === -1) return home;
  return home.slice(0, idx);
}

/** Per-profile root directory. `<base>/profiles/<name>/`. */
export function getProfileHome(name: string): string {
  if (name === DEFAULT_PROFILE_NAME) return getBaseHome();
  assertProfileName(name);
  const dir = join(getBaseHome(), 'profiles', name);
  // A per-profile root is itself a full state root — create it 0700 (audit F10).
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
  return dir;
}

/** The directory holding all named profiles: `<base>/profiles/`. */
export function getProfilesRoot(): string {
  const dir = join(getBaseHome(), 'profiles');
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
  return dir;
}

/** The active profile, persisted at `<base>/active-profile`. Returns
 *  `'default'` when no override is set. The CLI's `-p` flag bypasses
 *  this entirely by setting HARNESS_HOME directly before imports. */
export function getActiveProfile(): string {
  const path = join(getBaseHome(), ACTIVE_PROFILE_FILENAME);
  if (!existsSync(path)) return DEFAULT_PROFILE_NAME;
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return DEFAULT_PROFILE_NAME;
  // A corrupted / hand-edited active-profile file must never become an
  // unvalidated path segment joined into HARNESS_HOME (e.g. '../../etc' →
  // path traversal). Anything that isn't a well-formed profile name falls
  // back to the default root rather than escaping it.
  if (!PROFILE_NAME_RE.test(raw)) return DEFAULT_PROFILE_NAME;
  return raw;
}

/** Persist `name` as the active profile. Pass `'default'` (or empty
 *  string) to unset. */
export function setActiveProfile(name: string): void {
  const path = join(getBaseHome(), ACTIVE_PROFILE_FILENAME);
  if (name === DEFAULT_PROFILE_NAME || name.length === 0) {
    if (existsSync(path)) writeFileSync(path, '', 'utf8');
    return;
  }
  assertProfileName(name);
  writeFileSync(path, `${name}\n`, 'utf8');
}

/** Validate a profile name: ASCII alphanumerics + `.`, `_`, `-`, ≤ 64
 *  chars, must start with alphanumeric. Reserved names (`default`)
 *  must not pass through this check — handle them at the call site. */
export function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `invalid profile name ${JSON.stringify(name)}: must match ${PROFILE_NAME_RE} (alphanumeric, '.', '_', '-', ≤64 chars, leading alnum)`,
    );
  }
  if (name === DEFAULT_PROFILE_NAME) {
    throw new Error(`profile name 'default' is reserved`);
  }
}
