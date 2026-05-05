// Phase 10.8 — default-bundle resolver tests. Cover the user-override
// path, the shipped-fallback path, and the both-missing degenerate case.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultBundlePath,
  shippedBundlePath,
  userOverridePath,
} from '../../src/bundle/defaultBundle.js';

let savedHome: string | undefined;
let home: string;

beforeEach(() => {
  savedHome = process.env.HARNESS_HOME;
  home = mkdtempSync(join(tmpdir(), 'sov-default-bundle-'));
  process.env.HARNESS_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
  } else {
    process.env.HARNESS_HOME = savedHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('userOverridePath', () => {
  test('returns <harness-home>/default-bundle', () => {
    expect(userOverridePath()).toBe(join(home, 'default-bundle'));
  });
});

describe('shippedBundlePath', () => {
  test('returns the bundle-default/ that lives next to the runtime source', () => {
    const path = shippedBundlePath();
    expect(path).not.toBeNull();
    expect(path).toContain('bundle-default');
    // The shipped bundle is committed; index.yaml must exist.
    expect(existsSync(join(path ?? '', 'index.yaml'))).toBe(true);
  });
});

describe('getDefaultBundlePath', () => {
  test('returns the user override when it has an index.yaml', () => {
    const override = join(home, 'default-bundle');
    mkdirSync(override, { recursive: true });
    writeFileSync(join(override, 'index.yaml'), 'repo: my-override\n');
    expect(getDefaultBundlePath()).toBe(override);
  });

  test('falls back to the shipped bundle when the override is absent', () => {
    // No override created.
    const path = getDefaultBundlePath();
    expect(path).not.toBeNull();
    expect(path).toContain('bundle-default');
  });

  test('falls back to the shipped bundle when the override exists but lacks index.yaml', () => {
    // Empty directory at the override location — not a real bundle.
    mkdirSync(join(home, 'default-bundle'), { recursive: true });
    const path = getDefaultBundlePath();
    expect(path).not.toBeNull();
    expect(path).toContain('bundle-default');
    // Should NOT pick the empty override.
    expect(path).not.toBe(join(home, 'default-bundle'));
  });
});
