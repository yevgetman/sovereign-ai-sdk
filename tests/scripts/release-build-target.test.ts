import { describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  archivePathFor,
  packageStage,
  resolveTarget,
  shouldStageBundlePath,
  stagedBinaryPaths,
  validateBuildInputs,
} from '../../scripts/release-build-target';
import { TARGETS, type Target } from '../../scripts/release-shared';
import { collectZipEntries } from '../../scripts/release-zip';

function target(name: Target['name']): Target {
  const t = TARGETS.find((x) => x.name === name);
  if (!t) throw new Error(`no target ${name}`);
  return t;
}

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

  test('resolves windows-x64 (Telekit for Windows)', () => {
    const t = resolveTarget('windows-x64');
    expect(t).toEqual({
      name: 'windows-x64',
      bunTarget: 'bun-windows-x64',
      goos: 'windows',
      goarch: 'amd64',
    });
  });

  test('returns null for an unknown target', () => {
    expect(resolveTarget('freebsd-x64')).toBeNull();
    expect(resolveTarget('')).toBeNull();
  });
});

describe('release-build-target — stagedBinaryPaths', () => {
  test('windows binaries are sov.exe + sov-tui.exe under bin/', () => {
    const bins = stagedBinaryPaths('/stage', target('windows-x64'));
    expect(bins.sov).toBe(join('/stage', 'bin', 'sov.exe'));
    expect(bins.tui).toBe(join('/stage', 'bin', 'sov-tui.exe'));
  });

  test('darwin + linux binaries stay extension-less', () => {
    for (const name of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const) {
      const bins = stagedBinaryPaths('/stage', target(name));
      expect(bins.sov).toBe(join('/stage', 'bin', 'sov'));
      expect(bins.tui).toBe(join('/stage', 'bin', 'sov-tui'));
    }
  });
});

describe('release-build-target — archivePathFor', () => {
  test('windows lands as sov-windows-x64.zip, others as .tar.gz', () => {
    expect(archivePathFor('/rel', target('windows-x64'))).toBe(join('/rel', 'sov-windows-x64.zip'));
    expect(archivePathFor('/rel', target('linux-x64'))).toBe(join('/rel', 'sov-linux-x64.tar.gz'));
    expect(archivePathFor('/rel', target('darwin-arm64'))).toBe(
      join('/rel', 'sov-darwin-arm64.tar.gz'),
    );
  });
});

describe('release-build-target — packageStage (windows zip)', () => {
  test('zips a staged tree with the tarball layout rooted at the archive top', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sov-pkg-win-'));
    try {
      const stage = join(tmp, 'windows-x64');
      mkdirSync(join(stage, 'bin'), { recursive: true });
      mkdirSync(join(stage, 'bundle-default', 'state'), { recursive: true });
      writeFileSync(join(stage, 'bin', 'sov.exe'), 'MZ-sov');
      writeFileSync(join(stage, 'bin', 'sov-tui.exe'), 'MZ-tui');
      writeFileSync(join(stage, 'bundle-default', 'index.yaml'), 'projectId: x\n');
      writeFileSync(join(stage, 'bundle-default', 'state', '.gitkeep'), '');
      writeFileSync(join(stage, 'version'), 'v0.7.0\n');
      writeFileSync(join(stage, 'LICENSE.txt'), 'beta');
      writeFileSync(join(stage, 'README.md'), 'readme');

      const archive = archivePathFor(tmp, target('windows-x64'));
      packageStage(target('windows-x64'), stage, archive);

      expect(existsSync(archive)).toBe(true);
      expect(archive.endsWith('sov-windows-x64.zip')).toBe(true);
      // Re-walk the stage through the same collector the zip used, and
      // confirm the archive's first local header names the first entry.
      const entries = collectZipEntries(stage).map((e) => e.path);
      expect(entries).toEqual([
        'LICENSE.txt',
        'README.md',
        'bin/sov-tui.exe',
        'bin/sov.exe',
        'bundle-default/index.yaml',
        'bundle-default/state/.gitkeep',
        'version',
      ]);
      const bytes = readFileSync(archive);
      expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
      const nameLen = bytes.readUInt16LE(26);
      expect(bytes.subarray(30, 30 + nameLen).toString('utf8')).toBe('LICENSE.txt');
      const compressedLen = bytes.readUInt32LE(18);
      const payload = bytes.subarray(30 + nameLen, 30 + nameLen + compressedLen);
      expect(Buffer.from(deflateRawSync('beta', { level: 9 })).equals(payload)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
      target: 'freebsd-x64',
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
