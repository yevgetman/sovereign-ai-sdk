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
});
