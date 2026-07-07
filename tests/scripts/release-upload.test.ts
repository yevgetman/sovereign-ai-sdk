import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGhCreateArgs, collectTarballs, generateSums } from '../../scripts/release-upload';

function withTempReleaseDir(
  version: string,
  setup: (releaseDir: string) => void,
  body: (releaseDir: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'sov-upload-'));
  try {
    const releaseDir = join(root, 'build', 'release', version);
    mkdirSync(releaseDir, { recursive: true });
    setup(releaseDir);
    body(releaseDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('release-upload — collectTarballs', () => {
  test('returns the expected tarballs (derived from TARGETS) in canonical order when all present', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-darwin-arm64.tar.gz'), 'a');
        writeFileSync(join(dir, 'sov-darwin-x64.tar.gz'), 'b');
        writeFileSync(join(dir, 'sov-linux-x64.tar.gz'), 'c');
        writeFileSync(join(dir, 'sov-linux-arm64.tar.gz'), 'd');
      },
      (dir) => {
        const r = collectTarballs(dir);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.tarballs.map((p) => p.split('/').pop())).toEqual([
            'sov-darwin-arm64.tar.gz',
            'sov-darwin-x64.tar.gz',
            'sov-linux-x64.tar.gz',
            'sov-linux-arm64.tar.gz',
          ]);
        }
      },
    );
  });

  test('returns error listing missing tarballs', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-darwin-arm64.tar.gz'), 'a');
        // sov-darwin-x64 + sov-linux-x64 deliberately missing
      },
      (dir) => {
        const r = collectTarballs(dir);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toContain('sov-darwin-x64.tar.gz');
          expect(r.error).toContain('sov-linux-x64.tar.gz');
        }
      },
    );
  });
});

describe('release-upload — generateSums', () => {
  test('writes SHA256SUMS with one line per tarball', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-darwin-arm64.tar.gz'), 'a');
        writeFileSync(join(dir, 'sov-darwin-x64.tar.gz'), 'b');
        writeFileSync(join(dir, 'sov-linux-x64.tar.gz'), 'c');
      },
      (dir) => {
        const sumsPath = generateSums(dir, [
          join(dir, 'sov-darwin-arm64.tar.gz'),
          join(dir, 'sov-darwin-x64.tar.gz'),
          join(dir, 'sov-linux-x64.tar.gz'),
        ]);
        const body = readFileSync(sumsPath, 'utf8');
        // sha256("a") = ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb
        expect(body).toContain(
          'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  sov-darwin-arm64.tar.gz',
        );
        expect(body.trim().split('\n')).toHaveLength(3);
      },
    );
  });
});

describe('release-upload — buildGhCreateArgs', () => {
  test('builds gh release create with --notes-file + repo + assets', () => {
    const args = buildGhCreateArgs({
      version: 'v0.6.0',
      notesFilePath: '/tmp/CHANGELOG.md',
      assets: [
        '/tmp/sov-darwin-arm64.tar.gz',
        '/tmp/sov-darwin-x64.tar.gz',
        '/tmp/sov-linux-x64.tar.gz',
        '/tmp/SHA256SUMS',
      ],
    });
    expect(args[0]).toBe('release');
    expect(args[1]).toBe('create');
    expect(args[2]).toBe('v0.6.0');
    expect(args).toContain('--repo');
    expect(args).toContain('yevgetman/sov-releases');
    expect(args).toContain('--notes-file');
    expect(args).toContain('/tmp/CHANGELOG.md');
    expect(args).toContain('--title');
    expect(args).toContain('Sovereign AI SDK v0.6.0');
    expect(args).toContain('/tmp/SHA256SUMS');
  });
});
