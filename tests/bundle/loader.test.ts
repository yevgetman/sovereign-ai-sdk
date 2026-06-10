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

  test('a valid index.yaml still loads its fields', async () => {
    await withTmp(async (dir) => {
      writeMinimalBundle(dir);
      const bundle = await loadBundle(dir);
      expect(bundle.index.repo).toBe('test');
      expect(bundle.index.description).toBe('test bundle');
    });
  });
});
