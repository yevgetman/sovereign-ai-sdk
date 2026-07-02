// Phase 10.7 — `sov profile` subcommand cluster: list / create / use / show /
// import-default. All operations live under `<base>/profiles/`; the active
// profile is persisted at `<base>/active-profile` (read by main.ts when no
// `-p` flag is supplied).

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PROFILE_NAME,
  assertProfileName,
  getActiveProfile,
  getBaseHome,
  getProfileHome,
  getProfilesRoot,
  setActiveProfile,
} from '@yevgetman/sov-sdk/config/paths';

/** Files copied by `sov profile import-default`. Sessions/trajectories/memory
 *  stay empty in the new profile by design — a profile is meant to scope
 *  history per project, not duplicate it. */
const IMPORTABLE_FILES = ['config.json', 'credentials.json'] as const;

export type ProfileEntry = {
  name: string;
  active: boolean;
  path: string;
};

/** Enumerate every directory under `<base>/profiles/` plus the implicit
 *  'default' root. Returns names sorted alphabetically with the active
 *  profile marked. */
export function listProfiles(): ProfileEntry[] {
  const active = getActiveProfile();
  const root = getProfilesRoot();
  const names = new Set<string>();
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory()) names.add(entry);
    } catch {
      // racing rmdir / permission errors: skip silently.
    }
  }
  const entries: ProfileEntry[] = [];
  entries.push({
    name: DEFAULT_PROFILE_NAME,
    active: active === DEFAULT_PROFILE_NAME,
    path: getBaseHome(),
  });
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    entries.push({
      name,
      active: name === active,
      path: join(root, name),
    });
  }
  return entries;
}

export function formatProfileList(entries: ProfileEntry[]): string {
  const lines = entries.map((e) => {
    const marker = e.active ? '*' : ' ';
    return `${marker} ${e.name}`;
  });
  return `${lines.join('\n')}\n`;
}

export type CreateProfileResult = {
  name: string;
  path: string;
  alreadyExisted: boolean;
};

/** Create the profile directory under `<base>/profiles/<name>/`. Idempotent
 *  when the directory already exists — returns `alreadyExisted: true` so
 *  the CLI can warn but not crash on accidental re-creation. */
export function createProfile(name: string): CreateProfileResult {
  assertProfileName(name);
  const path = join(getBaseHome(), 'profiles', name);
  const alreadyExisted = existsSync(path);
  mkdirSync(path, { recursive: true });
  return { name, path, alreadyExisted };
}

/** Pin a profile as the persisted active selection at `<base>/active-profile`.
 *  Verifies the profile directory exists when not 'default' so a typo doesn't
 *  silently break future runs. */
export function useProfile(name: string): { name: string; path: string } {
  if (name === DEFAULT_PROFILE_NAME) {
    setActiveProfile(DEFAULT_PROFILE_NAME);
    return { name: DEFAULT_PROFILE_NAME, path: getBaseHome() };
  }
  assertProfileName(name);
  const path = join(getBaseHome(), 'profiles', name);
  if (!existsSync(path)) {
    throw new Error(`profile '${name}' not found — run 'sov profile create ${name}' first`);
  }
  setActiveProfile(name);
  return { name, path };
}

export type ImportDefaultResult = {
  copied: string[];
  skippedExisting: string[];
  skippedMissing: string[];
};

/** Copy the unscoped default-root config/credentials into a target profile.
 *  Designed as a one-shot bootstrap: refuses to overwrite existing target
 *  files (the user has to delete them deliberately). Files missing from the
 *  default root are reported but not treated as an error. */
export function importDefaultIntoProfile(name: string): ImportDefaultResult {
  if (name === DEFAULT_PROFILE_NAME) {
    throw new Error("cannot import default into 'default' — they're the same root");
  }
  assertProfileName(name);
  const profilePath = getProfileHome(name);
  const base = getBaseHome();
  const copied: string[] = [];
  const skippedExisting: string[] = [];
  const skippedMissing: string[] = [];
  for (const file of IMPORTABLE_FILES) {
    const src = join(base, file);
    const dest = join(profilePath, file);
    if (!existsSync(src)) {
      skippedMissing.push(file);
      continue;
    }
    if (existsSync(dest)) {
      skippedExisting.push(file);
      continue;
    }
    copyFileSync(src, dest);
    copied.push(file);
  }
  return { copied, skippedExisting, skippedMissing };
}

export function formatImportResult(result: ImportDefaultResult, profileName: string): string {
  const parts: string[] = [];
  if (result.copied.length > 0) {
    parts.push(`copied into '${profileName}': ${result.copied.join(', ')}`);
  }
  if (result.skippedExisting.length > 0) {
    parts.push(
      `already present in '${profileName}' (left alone): ${result.skippedExisting.join(', ')}`,
    );
  }
  if (result.skippedMissing.length > 0) {
    parts.push(`not in default root (skipped): ${result.skippedMissing.join(', ')}`);
  }
  if (parts.length === 0) parts.push('nothing to do');
  return `${parts.join('\n')}\n`;
}
