// Phase 10.7 — `sov profile` subcommand cluster. Exercises the pure logic;
// the commander wiring in main.ts is smoke-tested separately by the
// per-subcommand actions calling these directly.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProfile,
  formatImportResult,
  formatProfileList,
  importDefaultIntoProfile,
  listProfiles,
  useProfile,
} from '../../src/cli/profileCommands.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-prof-'));
  savedHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('listProfiles', () => {
  test('returns just the default entry on a fresh root', () => {
    const list = listProfiles();
    expect(list).toEqual([{ name: 'default', active: true, path: home }]);
  });

  test('includes created profiles in alphabetical order', () => {
    createProfile('zeta');
    createProfile('alpha');
    createProfile('mid');
    const list = listProfiles();
    expect(list.map((e) => e.name)).toEqual(['default', 'alpha', 'mid', 'zeta']);
  });

  test('marks the active profile only', () => {
    createProfile('work');
    createProfile('personal');
    useProfile('work');
    const list = listProfiles();
    const active = list.filter((e) => e.active).map((e) => e.name);
    expect(active).toEqual(['work']);
  });
});

describe('formatProfileList', () => {
  test("renders '*' beside the active entry and ' ' beside others", () => {
    const out = formatProfileList([
      { name: 'default', active: false, path: '/x' },
      { name: 'work', active: true, path: '/x/profiles/work' },
    ]);
    expect(out).toBe('  default\n* work\n');
  });
});

describe('createProfile', () => {
  test('creates a fresh directory', () => {
    const result = createProfile('work');
    expect(result.alreadyExisted).toBe(false);
    expect(existsSync(result.path)).toBe(true);
  });

  test('returns alreadyExisted: true when called twice', () => {
    createProfile('work');
    const second = createProfile('work');
    expect(second.alreadyExisted).toBe(true);
  });

  test('rejects invalid profile names', () => {
    expect(() => createProfile('has spaces')).toThrow(/invalid profile/);
    expect(() => createProfile('.dotfile')).toThrow(/invalid profile/);
    expect(() => createProfile('default')).toThrow(/reserved/);
  });
});

describe('useProfile', () => {
  test('writes <base>/active-profile and returns the path', () => {
    createProfile('work');
    const result = useProfile('work');
    expect(result.name).toBe('work');
    expect(readFileSync(join(home, 'active-profile'), 'utf8').trim()).toBe('work');
  });

  test("'default' clears the active-profile file", () => {
    createProfile('work');
    useProfile('work');
    const result = useProfile('default');
    expect(result.name).toBe('default');
    // `setActiveProfile('default')` writes an empty string but leaves the
    // file in place; reading back yields the default.
    expect(readFileSync(join(home, 'active-profile'), 'utf8')).toBe('');
  });

  test('refuses to activate a profile that has not been created', () => {
    expect(() => useProfile('ghost')).toThrow(/not found/);
  });
});

describe('importDefaultIntoProfile', () => {
  test('copies present default-root files and skips missing ones', () => {
    writeFileSync(join(home, 'config.json'), '{"x":1}', 'utf8');
    createProfile('work');
    const result = importDefaultIntoProfile('work');
    expect(result.copied).toEqual(['config.json']);
    expect(result.skippedMissing).toEqual(['credentials.json']);
    expect(result.skippedExisting).toEqual([]);
    expect(readFileSync(join(home, 'profiles', 'work', 'config.json'), 'utf8')).toBe('{"x":1}');
  });

  test('refuses to overwrite existing target files', () => {
    writeFileSync(join(home, 'config.json'), 'src', 'utf8');
    createProfile('work');
    writeFileSync(join(home, 'profiles', 'work', 'config.json'), 'preexisting', 'utf8');
    const result = importDefaultIntoProfile('work');
    expect(result.copied).toEqual([]);
    expect(result.skippedExisting).toEqual(['config.json']);
    expect(readFileSync(join(home, 'profiles', 'work', 'config.json'), 'utf8')).toBe('preexisting');
  });

  test("rejects 'default' as a target", () => {
    expect(() => importDefaultIntoProfile('default')).toThrow(/cannot import default/);
  });
});

describe('formatImportResult', () => {
  test('summarizes copies, skips, and missing entries', () => {
    const out = formatImportResult(
      {
        copied: ['config.json'],
        skippedExisting: ['credentials.json'],
        skippedMissing: [],
      },
      'work',
    );
    expect(out).toContain("copied into 'work': config.json");
    expect(out).toContain("already present in 'work'");
  });

  test("'nothing to do' when every list is empty", () => {
    const out = formatImportResult({ copied: [], skippedExisting: [], skippedMissing: [] }, 'work');
    expect(out.trim()).toBe('nothing to do');
  });
});
