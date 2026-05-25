import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER,
  PUBLIC_REPO,
  TARGETS,
  repoRoot,
  satisfies,
  sha256,
} from '../../scripts/release-shared';

describe('release-shared — TARGETS', () => {
  test('exports exactly the three day-one targets in canonical order', () => {
    expect(TARGETS.map((t) => t.name)).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64']);
  });

  test('each target carries its bun-target + goos + goarch pair', () => {
    const arm64 = TARGETS.find((t) => t.name === 'darwin-arm64');
    expect(arm64?.bunTarget).toBe('bun-darwin-arm64');
    expect(arm64?.goos).toBe('darwin');
    expect(arm64?.goarch).toBe('arm64');
  });
});

describe('release-shared — constants', () => {
  test('OWNER and PUBLIC_REPO point at yevgetman/sov-releases', () => {
    expect(OWNER).toBe('yevgetman');
    expect(PUBLIC_REPO).toBe('sov-releases');
  });
});

describe('release-shared — satisfies', () => {
  test('returns true when have == need', () => {
    expect(satisfies('1.2.0', '1.2.0')).toBe(true);
  });

  test('returns true when have > need', () => {
    expect(satisfies('1.2.5', '1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '1.2.0')).toBe(true);
  });

  test('returns false when have < need', () => {
    expect(satisfies('1.1.99', '1.2.0')).toBe(false);
    expect(satisfies('0.9.0', '1.2.0')).toBe(false);
  });

  test('treats missing patch digit as zero', () => {
    expect(satisfies('1.2', '1.2.0')).toBe(true);
    expect(satisfies('1.2.0', '1.2')).toBe(true);
  });
});

describe('release-shared — sha256', () => {
  test('hashes the exact bytes of the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-sha256-'));
    try {
      const p = join(dir, 'sample.bin');
      writeFileSync(p, 'hello world');
      // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
      expect(sha256(p)).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release-shared — repoRoot', () => {
  test('resolves to a directory containing package.json', async () => {
    const root = repoRoot();
    const pkg = Bun.file(join(root, 'package.json'));
    expect(await pkg.exists()).toBe(true);
  });
});
