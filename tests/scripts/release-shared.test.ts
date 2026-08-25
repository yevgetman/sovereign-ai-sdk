import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER,
  PUBLIC_REPO,
  TARGETS,
  archiveFormat,
  artifactName,
  executableName,
  isWindowsTarget,
  repoRoot,
  satisfies,
  sha256,
} from '../../scripts/release-shared';

describe('release-shared — TARGETS', () => {
  test('exports the supported targets in canonical order', () => {
    expect(TARGETS.map((t) => t.name)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
      'windows-x64',
    ]);
  });

  test('each target carries its bun-target + goos + goarch pair', () => {
    const arm64 = TARGETS.find((t) => t.name === 'darwin-arm64');
    expect(arm64?.bunTarget).toBe('bun-darwin-arm64');
    expect(arm64?.goos).toBe('darwin');
    expect(arm64?.goarch).toBe('arm64');

    // linux-arm64 (the ARM Linux container target, e.g. the Appleo gateway).
    const linuxArm64 = TARGETS.find((t) => t.name === 'linux-arm64');
    expect(linuxArm64?.bunTarget).toBe('bun-linux-arm64');
    expect(linuxArm64?.goos).toBe('linux');
    expect(linuxArm64?.goarch).toBe('arm64');
  });

  test('windows-x64 target carries exactly the spec §5.3 fields', () => {
    const windows = TARGETS.find((t) => t.name === 'windows-x64');
    expect(windows).toEqual({
      name: 'windows-x64',
      bunTarget: 'bun-windows-x64',
      goos: 'windows',
      goarch: 'amd64',
    });
  });

  test('darwin + linux entries are unchanged by the windows addition', () => {
    expect(TARGETS.slice(0, 4)).toEqual([
      { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', goos: 'darwin', goarch: 'arm64' },
      { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', goos: 'darwin', goarch: 'amd64' },
      { name: 'linux-x64', bunTarget: 'bun-linux-x64', goos: 'linux', goarch: 'amd64' },
      { name: 'linux-arm64', bunTarget: 'bun-linux-arm64', goos: 'linux', goarch: 'arm64' },
    ]);
  });

  test('windows is the only target with goos windows', () => {
    expect(TARGETS.filter(isWindowsTarget).map((t) => t.name)).toEqual(['windows-x64']);
  });
});

describe('release-shared — executableName', () => {
  test('appends .exe on windows', () => {
    expect(executableName('sov', { goos: 'windows' })).toBe('sov.exe');
    expect(executableName('sov-tui', { goos: 'windows' })).toBe('sov-tui.exe');
  });

  test('leaves darwin + linux binaries extension-less', () => {
    expect(executableName('sov', { goos: 'darwin' })).toBe('sov');
    expect(executableName('sov-tui', { goos: 'linux' })).toBe('sov-tui');
  });
});

describe('release-shared — archiveFormat + artifactName', () => {
  test('windows ships a zip, everything else a tar.gz', () => {
    expect(archiveFormat({ goos: 'windows' })).toBe('zip');
    expect(archiveFormat({ goos: 'darwin' })).toBe('tar.gz');
    expect(archiveFormat({ goos: 'linux' })).toBe('tar.gz');
  });

  test('artifact names follow sov-<target>.<format> for every target', () => {
    expect(TARGETS.map(artifactName)).toEqual([
      'sov-darwin-arm64.tar.gz',
      'sov-darwin-x64.tar.gz',
      'sov-linux-x64.tar.gz',
      'sov-linux-arm64.tar.gz',
      'sov-windows-x64.zip',
    ]);
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
