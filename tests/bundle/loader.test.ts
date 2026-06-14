// Bundle loader tests. Focused on the tolerant `loadBundleIfPresent` entry
// point used by the CLI to support both bundled and generic-agent runs.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundle, loadBundleIfPresent } from '../../src/bundle/loader.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-bundle-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMinimalBundle(root: string): void {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(
    join(root, 'index.yaml'),
    'repo: test\ndescription: test bundle\nupdated: 2026-05-01\n',
  );
}

describe('loadBundleIfPresent', () => {
  test('returns null when path is null', async () => {
    expect(await loadBundleIfPresent(null)).toBeNull();
  });

  test('returns null when index.yaml is missing', async () => {
    await withTmp(async (dir) => {
      expect(await loadBundleIfPresent(dir)).toBeNull();
    });
  });

  test('loads the bundle when index.yaml is present', async () => {
    await withTmp(async (dir) => {
      writeMinimalBundle(dir);
      const bundle = await loadBundleIfPresent(dir);
      expect(bundle).not.toBeNull();
      expect(bundle?.index.repo).toBe('test');
    });
  });
});

describe('loadBundle', () => {
  test('throws when index.yaml is missing', async () => {
    await withTmp(async (dir) => {
      await expect(loadBundle(dir)).rejects.toThrow(/index\.yaml/);
    });
  });

  // FIX 6 — a malformed index.yaml that parses to null / scalar / array must
  // NOT crash session boot. resolveProjectScope reads `bundle.index.projectId`,
  // which would TypeError on a null index. The loader normalizes to a safe
  // object instead.
  test('returns a safe (empty) index when index.yaml is empty (parses to null)', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.yaml'), '');
      const bundle = await loadBundle(dir);
      // A plain object, not null — so `bundle.index.projectId` is safe.
      expect(bundle.index).toBeInstanceOf(Object);
      expect(Array.isArray(bundle.index)).toBe(false);
      expect(bundle.index.projectId).toBeUndefined();
    });
  });

  test('returns a safe index when index.yaml is a bare scalar', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.yaml'), 'just a string');
      const bundle = await loadBundle(dir);
      expect(bundle.index).toBeInstanceOf(Object);
      expect(Array.isArray(bundle.index)).toBe(false);
      expect(bundle.index.repo).toBeUndefined();
    });
  });

  test('returns a safe index when index.yaml is a top-level array', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.yaml'), '- one\n- two\n');
      const bundle = await loadBundle(dir);
      expect(bundle.index).toBeInstanceOf(Object);
      expect(Array.isArray(bundle.index)).toBe(false);
    });
  });

  // Finding #22 — M14's shape guard only validated the TOP-LEVEL object, not
  // field TYPES, so a non-string `repo:`/`projectId:` (a plausible YAML typo)
  // survived normalization and then crashed boot at resolveProjectScope's
  // `bundle.index.repo?.trim()`. normalizeBundleIndex now drops non-string
  // values for the known string fields and warns, achieving M14's stated goal
  // of surviving a typo'd bundle.
  test('drops a non-string repo (numeric typo) so it never reaches .trim()', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.yaml'), 'repo: 123\nprojectId: my-bundle\n');
      const bundle = await loadBundle(dir);
      expect(bundle.index.repo).toBeUndefined();
      // The valid string field survives.
      expect(bundle.index.projectId).toBe('my-bundle');
    });
  });

  test('drops a list-valued repo', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.yaml'), 'repo:\n  - a\n  - b\n');
      const bundle = await loadBundle(dir);
      expect(bundle.index.repo).toBeUndefined();
    });
  });

  test('drops a non-string projectId (numeric typo)', async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, 'index.yaml'), 'projectId: 42\nrepo: my-repo\n');
      const bundle = await loadBundle(dir);
      expect(bundle.index.projectId).toBeUndefined();
      expect(bundle.index.repo).toBe('my-repo');
    });
  });

  test('a valid index.yaml still loads its fields', async () => {
    await withTmp(async (dir) => {
      writeMinimalBundle(dir);
      const bundle = await loadBundle(dir);
      expect(bundle.index.repo).toBe('test');
      expect(bundle.index.description).toBe('test bundle');
    });
  });
});
