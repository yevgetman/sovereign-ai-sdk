import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  EXPECTED_ARTIFACT_NAMES,
  buildGhCreateArgs,
  collectArtifacts,
  generateSums,
} from '../../scripts/release-upload';

const ALL_ARTIFACTS = [
  'sov-darwin-arm64.tar.gz',
  'sov-darwin-x64.tar.gz',
  'sov-linux-x64.tar.gz',
  'sov-linux-arm64.tar.gz',
  'sov-windows-x64.zip',
] as const;

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

describe('release-upload — EXPECTED_ARTIFACT_NAMES', () => {
  test('is derived from TARGETS: tar.gz for darwin/linux, zip for windows', () => {
    expect(EXPECTED_ARTIFACT_NAMES).toEqual([...ALL_ARTIFACTS]);
  });
});

describe('release-upload — collectArtifacts', () => {
  test('returns the expected artifacts (derived from TARGETS) in canonical order when all present', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        for (const name of ALL_ARTIFACTS) writeFileSync(join(dir, name), name);
      },
      (dir) => {
        const r = collectArtifacts(dir);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.artifacts.map((p) => basename(p))).toEqual([...ALL_ARTIFACTS]);
        }
      },
    );
  });

  test('returns error listing missing artifacts, including the windows zip', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-darwin-arm64.tar.gz'), 'a');
        // sov-darwin-x64 + sov-linux-x64 + sov-windows-x64 deliberately missing
      },
      (dir) => {
        const r = collectArtifacts(dir);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toContain('sov-darwin-x64.tar.gz');
          expect(r.error).toContain('sov-linux-x64.tar.gz');
          expect(r.error).toContain('sov-windows-x64.zip');
        }
      },
    );
  });

  test('does not accept a tar.gz in place of the windows zip', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        for (const name of ALL_ARTIFACTS) {
          if (name !== 'sov-windows-x64.zip') writeFileSync(join(dir, name), name);
        }
        writeFileSync(join(dir, 'sov-windows-x64.tar.gz'), 'wrong format');
      },
      (dir) => {
        const r = collectArtifacts(dir);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('sov-windows-x64.zip');
      },
    );
  });
});

describe('release-upload — generateSums', () => {
  test('writes SHA256SUMS with one line per artifact', () => {
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

  test('covers the windows zip with a SHA256SUMS line', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-windows-x64.zip'), 'a');
      },
      (dir) => {
        const body = readFileSync(generateSums(dir, [join(dir, 'sov-windows-x64.zip')]), 'utf8');
        expect(body).toBe(
          'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  sov-windows-x64.zip\n',
        );
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
        '/tmp/sov-windows-x64.zip',
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
    expect(args).toContain('/tmp/sov-windows-x64.zip');
    expect(args).toContain('/tmp/SHA256SUMS');
  });
});
