import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTarget,
  shouldStageBundlePath,
  validateBuildInputs,
} from '../../scripts/release-build-target';

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

describe('release-build-target — shouldStageBundlePath (audit C1: no state leak)', () => {
  const bundleRoot = '/repo/bundle-default';

  test('stages content outside state/', () => {
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/index.yaml')).toBe(true);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/agents/explore.md')).toBe(true);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/business/x.md')).toBe(true);
  });

  test('keeps the state/ dir shell and its tracked .gitkeep', () => {
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state')).toBe(true);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state/.gitkeep')).toBe(true);
  });

  test('DROPS captured runtime state (the leak vector)', () => {
    expect(
      shouldStageBundlePath(
        bundleRoot,
        '/repo/bundle-default/state/artifacts/trajectories/failed.jsonl',
      ),
    ).toBe(false);
    expect(
      shouldStageBundlePath(
        bundleRoot,
        '/repo/bundle-default/state/artifacts/trajectories/samples.jsonl',
      ),
    ).toBe(false);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state/sessions.db')).toBe(false);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state/secret.env')).toBe(false);
  });

  test('end-to-end: cpSync with the filter excludes state trajectories but keeps .gitkeep', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sov-stage-'));
    try {
      const src = join(tmp, 'bundle-default');
      mkdirSync(join(src, 'state', 'artifacts', 'trajectories'), { recursive: true });
      mkdirSync(join(src, 'agents'), { recursive: true });
      writeFileSync(join(src, 'index.yaml'), 'projectId: x\n');
      writeFileSync(join(src, 'agents', 'explore.md'), 'agent');
      writeFileSync(join(src, 'state', '.gitkeep'), '');
      writeFileSync(
        join(src, 'state', 'artifacts', 'trajectories', 'failed.jsonl'),
        'SECRET gho_xxx',
      );

      const dest = join(tmp, 'stage', 'bundle-default');
      cpSync(src, dest, { recursive: true, filter: (s) => shouldStageBundlePath(src, s) });

      expect(existsSync(join(dest, 'index.yaml'))).toBe(true);
      expect(existsSync(join(dest, 'agents', 'explore.md'))).toBe(true);
      expect(existsSync(join(dest, 'state', '.gitkeep'))).toBe(true);
      expect(existsSync(join(dest, 'state', 'artifacts', 'trajectories', 'failed.jsonl'))).toBe(
        false,
      );
      expect(existsSync(join(dest, 'state', 'artifacts'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
