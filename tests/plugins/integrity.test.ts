// Plugin tree-hash integrity tests (T2). `hashPluginTree` is the load-bearing
// tamper-evidence primitive (S1): a deterministic content hash over EVERY file
// in a plugin tree EXCEPT the `.consent.json` record itself (so writing the
// record cannot invalidate the hash it records). The T3 loader compares this
// against the hash stored at consent to detect a tree edited after consent
// (the TOCTOU H4 case). These tests pin: stability across repeated calls, that
// any content/addition/removal flips the hash, that ordering is normalized
// (walk-order independent), nested-dir handling, and the `.consent.json`
// exclusion.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPluginTree } from '../../src/plugins/integrity.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-integrity-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedSimpleTree(root: string): void {
  writeFileSync(join(root, 'plugin.json'), '{"name":"p"}', 'utf8');
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a.md'), '# skill a', 'utf8');
}

describe('hashPluginTree — determinism', () => {
  test('returns the same hash on repeated calls over an unchanged tree', () => {
    seedSimpleTree(dir);
    const first = hashPluginTree(dir);
    const second = hashPluginTree(dir);
    expect(first).toBe(second);
  });

  test('produces a SHA-256 hex string (64 hex chars)', () => {
    seedSimpleTree(dir);
    expect(hashPluginTree(dir)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashPluginTree — tamper evidence', () => {
  test('changes when a file’s content changes', () => {
    seedSimpleTree(dir);
    const before = hashPluginTree(dir);
    writeFileSync(join(dir, 'skills', 'a.md'), '# skill a (edited)', 'utf8');
    expect(hashPluginTree(dir)).not.toBe(before);
  });

  test('changes when a new file is added', () => {
    seedSimpleTree(dir);
    const before = hashPluginTree(dir);
    writeFileSync(join(dir, 'skills', 'b.md'), '# skill b', 'utf8');
    expect(hashPluginTree(dir)).not.toBe(before);
  });

  test('changes when a file is removed', () => {
    seedSimpleTree(dir);
    const before = hashPluginTree(dir);
    rmSync(join(dir, 'skills', 'a.md'));
    expect(hashPluginTree(dir)).not.toBe(before);
  });

  test('distinguishes content moved between files (path is folded in)', () => {
    // Two files with swapped contents must NOT hash the same as the original:
    // the relative path is part of the hashed material, so where bytes live matters.
    writeFileSync(join(dir, 'x.txt'), 'alpha', 'utf8');
    writeFileSync(join(dir, 'y.txt'), 'beta', 'utf8');
    const before = hashPluginTree(dir);
    writeFileSync(join(dir, 'x.txt'), 'beta', 'utf8');
    writeFileSync(join(dir, 'y.txt'), 'alpha', 'utf8');
    expect(hashPluginTree(dir)).not.toBe(before);
  });
});

describe('hashPluginTree — .consent.json exclusion', () => {
  test('adding a .consent.json file does not change the hash', () => {
    seedSimpleTree(dir);
    const before = hashPluginTree(dir);
    writeFileSync(join(dir, '.consent.json'), '{"pluginId":"p"}', 'utf8');
    expect(hashPluginTree(dir)).toBe(before);
  });

  test('rewriting an existing .consent.json file does not change the hash', () => {
    seedSimpleTree(dir);
    writeFileSync(join(dir, '.consent.json'), '{"a":1}', 'utf8');
    const before = hashPluginTree(dir);
    writeFileSync(join(dir, '.consent.json'), '{"a":2,"b":3}', 'utf8');
    expect(hashPluginTree(dir)).toBe(before);
  });

  test('only .consent.json is excluded — other dotfiles ARE hashed', () => {
    seedSimpleTree(dir);
    const before = hashPluginTree(dir);
    writeFileSync(join(dir, '.gitignore'), 'node_modules', 'utf8');
    expect(hashPluginTree(dir)).not.toBe(before);
  });
});

describe('hashPluginTree — nested directories', () => {
  test('hashes files in nested subdirectories', () => {
    seedSimpleTree(dir);
    mkdirSync(join(dir, 'commands', 'nested', 'deep'), { recursive: true });
    const before = hashPluginTree(dir);
    writeFileSync(join(dir, 'commands', 'nested', 'deep', 'c.md'), 'deep file', 'utf8');
    expect(hashPluginTree(dir)).not.toBe(before);
  });
});

describe('hashPluginTree — order independence', () => {
  test('two trees with identical content seeded in different order hash equal', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'plugin-integrity-b-'));
    try {
      // Tree A: write nested file first, then top-level.
      mkdirSync(join(dir, 'skills'), { recursive: true });
      writeFileSync(join(dir, 'skills', 'z.md'), 'zed', 'utf8');
      writeFileSync(join(dir, 'plugin.json'), '{"name":"p"}', 'utf8');
      writeFileSync(join(dir, 'a.md'), 'aaa', 'utf8');

      // Tree B: write top-level first, then nested — different creation order.
      writeFileSync(join(otherDir, 'a.md'), 'aaa', 'utf8');
      writeFileSync(join(otherDir, 'plugin.json'), '{"name":"p"}', 'utf8');
      mkdirSync(join(otherDir, 'skills'), { recursive: true });
      writeFileSync(join(otherDir, 'skills', 'z.md'), 'zed', 'utf8');

      expect(hashPluginTree(dir)).toBe(hashPluginTree(otherDir));
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
