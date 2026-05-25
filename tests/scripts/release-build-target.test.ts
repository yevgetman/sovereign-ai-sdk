import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTarget, validateBuildInputs } from '../../scripts/release-build-target';

describe('release-build-target — resolveTarget', () => {
  test('returns the target spec for a known name', () => {
    const t = resolveTarget('darwin-arm64');
    expect(t).not.toBeNull();
    if (t === null) throw new Error('unreachable');
    expect(t.name).toBe('darwin-arm64');
    expect(t.bunTarget).toBe('bun-darwin-arm64');
    expect(t.goos).toBe('darwin');
    expect(t.goarch).toBe('arm64');
  });

  test('returns null for an unknown target', () => {
    expect(resolveTarget('windows-x64')).toBeNull();
    expect(resolveTarget('')).toBeNull();
  });
});

describe('release-build-target — validateBuildInputs', () => {
  test('returns ok when both target + version look valid and LICENSE.txt exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-build-valid-'));
    try {
      writeFileSync(join(dir, 'LICENSE.txt'), 'beta');
      const r = validateBuildInputs({
        target: 'darwin-arm64',
        version: 'v0.6.0',
        publicRepoPath: dir,
      });
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns error for an unknown target', () => {
    const r = validateBuildInputs({
      target: 'windows-x64',
      version: 'v0.6.0',
      publicRepoPath: '/some/path',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('unknown target');
  });

  test('returns error for a bad version format', () => {
    const r = validateBuildInputs({
      target: 'darwin-arm64',
      version: 'not-a-version',
      publicRepoPath: '/some/path',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('bad version');
  });

  test('returns error when publicRepoPath has no LICENSE.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-build-empty-'));
    try {
      const r = validateBuildInputs({
        target: 'darwin-arm64',
        version: 'v0.6.0',
        publicRepoPath: dir,
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('LICENSE.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
