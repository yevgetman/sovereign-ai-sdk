// Phase 10.7 — coverage for the profile-aware path helpers in
// src/config/paths.ts. The focus here is the pieces that aren't already
// exercised through profileCommands / profileLock: the base-home strip,
// the active-profile file edge cases, and the name validator.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROFILE_NAME,
  assertProfileName,
  getActiveProfile,
  getBaseHome,
  getProfileHome,
  resolveHarnessHome,
  setActiveProfile,
} from '../../src/config/paths.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-paths-'));
  savedHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('resolveHarnessHome', () => {
  test('returns HARNESS_HOME verbatim when set', () => {
    expect(resolveHarnessHome()).toBe(home);
  });

  test('mkdir is idempotent when the directory already exists', () => {
    expect(resolveHarnessHome()).toBe(home);
    expect(resolveHarnessHome()).toBe(home);
  });
});

describe('getBaseHome', () => {
  test('returns HARNESS_HOME unchanged when no profile suffix is present', () => {
    expect(getBaseHome()).toBe(home);
  });

  test('strips a /profiles/<name>/ suffix to recover the base root', () => {
    const profileHome = join(home, 'profiles', 'work');
    mkdirSync(profileHome, { recursive: true });
    process.env.HARNESS_HOME = profileHome;
    expect(getBaseHome()).toBe(home);
  });
});

describe('getProfileHome', () => {
  test("'default' maps to the base root, no profiles/ subdir", () => {
    expect(getProfileHome(DEFAULT_PROFILE_NAME)).toBe(home);
  });

  test('a named profile lands under <base>/profiles/<name>/', () => {
    const path = getProfileHome('work');
    expect(path).toBe(join(home, 'profiles', 'work'));
  });
});

describe('getActiveProfile / setActiveProfile', () => {
  test("returns 'default' when active-profile does not exist", () => {
    expect(getActiveProfile()).toBe(DEFAULT_PROFILE_NAME);
  });

  test("returns 'default' when active-profile is empty", () => {
    writeFileSync(join(home, 'active-profile'), '', 'utf8');
    expect(getActiveProfile()).toBe(DEFAULT_PROFILE_NAME);
  });

  test('returns the trimmed contents when active-profile holds a name', () => {
    writeFileSync(join(home, 'active-profile'), '  work\n', 'utf8');
    expect(getActiveProfile()).toBe('work');
  });

  test("setActiveProfile('default') clears the file in place", () => {
    setActiveProfile('work');
    expect(readFileSync(join(home, 'active-profile'), 'utf8').trim()).toBe('work');
    setActiveProfile(DEFAULT_PROFILE_NAME);
    expect(readFileSync(join(home, 'active-profile'), 'utf8')).toBe('');
  });

  test("setActiveProfile('') is treated like 'default'", () => {
    setActiveProfile('work');
    setActiveProfile('');
    expect(readFileSync(join(home, 'active-profile'), 'utf8')).toBe('');
  });

  test('setActiveProfile rejects names that fail validation', () => {
    expect(() => setActiveProfile('has spaces')).toThrow(/invalid profile/);
  });
});

describe('assertProfileName', () => {
  test('accepts valid alphanumeric + . _ - names', () => {
    for (const name of ['work', 'work-1', 'work_1', 'work.1', 'A', '1abc']) {
      expect(() => assertProfileName(name)).not.toThrow();
    }
  });

  test('rejects names that start with a non-alphanumeric character', () => {
    for (const name of ['-work', '_work', '.work']) {
      expect(() => assertProfileName(name)).toThrow(/invalid profile/);
    }
  });

  test("treats 'default' as reserved", () => {
    expect(() => assertProfileName('default')).toThrow(/reserved/);
  });

  test('rejects names with disallowed characters', () => {
    for (const name of ['a/b', 'a b', 'a$b', 'a:b', 'a;b']) {
      expect(() => assertProfileName(name)).toThrow(/invalid profile/);
    }
  });

  test('rejects names longer than 64 characters', () => {
    expect(() => assertProfileName('a'.repeat(65))).toThrow(/invalid profile/);
    expect(() => assertProfileName('a'.repeat(64))).not.toThrow();
  });
});
